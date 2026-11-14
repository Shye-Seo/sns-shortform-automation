import { generateHookVariants } from '../../src/lib/telemetry/hooks';
import { evaluateExperiment, requiredSampleSize, twoProportionZTest, wilsonInterval } from '../../src/lib/telemetry/significance';
import type { ExperimentEvaluation, ProportionMetric, VariantAggregate } from '../../src/types/telemetry';

/**
 * Hook A/B panel.
 *
 * Two hooks for the same episode, four rates a shortform operator actually
 * reads, and one decision made by the repository's own statistics module
 * (`src/lib/telemetry/significance.ts`):
 * - `evaluateExperiment` for the ratio metrics (leader vs runner-up only, with a
 *   minimum lift, so three variants cannot manufacture a winner);
 * - `twoProportionZTest` + `wilsonInterval` for coupon conversion, which is a
 *   per-view proportion rather than a telemetry aggregate.
 *
 * The counts are simulated. Everything above the counts is the production code.
 */

export type ArmId = 'A' | 'B';

export interface Arm {
  id: ArmId;
  angle: string | null;
  templateId: string;
  text: string;
  hookSeconds: number;
  impressions: number;
  views3s: number;
  completions: number;
  comments: number;
  couponClaims: number;
}

export interface MetricRow {
  key: 'viewRate3s' | 'retention' | 'commentRate' | 'couponRate';
  label: string;
  hint: string;
  a: { rate: number; successes: number; trials: number; lower: number; upper: number };
  b: { rate: number; successes: number; trials: number; lower: number; upper: number };
  lift: number;
  pValue: number;
  significant: boolean;
  leader: ArmId | null;
}

export interface AbResult {
  rows: MetricRow[];
  primary: ExperimentEvaluation;
  coupon: { z: number; pValue: number; standardError: number };
  winner: ArmId | null;
  confidence: number;
  requiredSample: number;
  notes: string[];
  ready: boolean;
}

const PRIMARY_METRIC: ProportionMetric = 'retention';
const MIN_SAMPLE = 200;
const MIN_LIFT = 0.05;
const ALPHA = 0.05;

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function binomial(trials: number, probability: number, random: () => number): number {
  if (trials <= 0) return 0;
  // Small samples are drawn one by one; large ones use a normal approximation
  // because 8,000 Bernoulli draws per click is wasted work in a browser.
  if (trials <= 600) {
    let hits = 0;
    for (let index = 0; index < trials; index += 1) if (random() < probability) hits += 1;
    return hits;
  }
  const mean = trials * probability;
  const sd = Math.sqrt(trials * probability * (1 - probability));
  let sum = 0;
  for (let index = 0; index < 12; index += 1) sum += random();
  const normal = (sum - 6) / Math.sqrt(1 / 12);
  const draw = Math.round(mean + sd * normal);
  return Math.max(0, Math.min(trials, draw));
}

/** Ground truth of each arm, in the proportions a Reels audience produces. */
interface Truth {
  viewRate3s: number;
  retention: number;
  commentRate: number;
  couponRate: number;
}

const TRUTH: Record<ArmId, Truth> = {
  A: { viewRate3s: 0.618, retention: 0.342, commentRate: 0.019, couponRate: 0.171 },
  B: { viewRate3s: 0.664, retention: 0.401, commentRate: 0.023, couponRate: 0.214 },
};

export class AbTest {
  arms: Arm[];

  private seed: number;

  constructor(topic: string, seed = 20261114) {
    this.seed = seed;
    this.arms = this.makeArms(topic);
  }

  private makeArms(topic: string): Arm[] {
    let variants;
    try {
      variants = generateHookVariants(topic, { count: 2 });
    } catch {
      // A topic too long to fit 3.5s falls back to the first two angles on a
      // shortened topic; the panel still has something to test.
      variants = generateHookVariants(topic.slice(0, 12) || '주방 수납', { count: 2 });
    }
    return variants.slice(0, 2).map((variant, index) => ({
      id: (['A', 'B'] as ArmId[])[index] as ArmId,
      angle: variant.angle,
      templateId: variant.templateId,
      text: variant.text,
      hookSeconds: variant.hookSeconds,
      impressions: 0,
      views3s: 0,
      completions: 0,
      comments: 0,
      couponClaims: 0,
    }));
  }

  get totalImpressions(): number {
    return this.arms.reduce((sum, arm) => sum + arm.impressions, 0);
  }

  reset(topic: string, seed?: number): void {
    this.seed = seed ?? this.seed;
    this.arms = this.makeArms(topic);
  }

  /** Collect `perArm` more impressions for each arm. */
  collect(perArm: number): void {
    const random = mulberry32(this.seed + perArm * 31 + (this.totalImpressions >> 3));
    this.arms = this.arms.map((arm) => {
      const truth = TRUTH[arm.id];
      const impressions = perArm;
      const views3s = binomial(impressions, truth.viewRate3s, random);
      const completions = binomial(views3s, truth.retention, random);
      const comments = binomial(impressions, truth.commentRate, random);
      const couponClaims = binomial(views3s, truth.couponRate, random);
      return {
        ...arm,
        impressions: arm.impressions + impressions,
        views3s: arm.views3s + views3s,
        completions: arm.completions + completions,
        comments: arm.comments + comments,
        couponClaims: arm.couponClaims + couponClaims,
      };
    });
  }

  private aggregates(window: '24h' | '7d' = '24h'): VariantAggregate[] {
    return this.arms.map((arm) => ({
      experimentId: 'exp-kitchen-hook',
      variantId: arm.id,
      window,
      impressions: arm.impressions,
      views3s: arm.views3s,
      watchTimeSec: arm.completions * 12,
      completions: arm.completions,
      likes: Math.round(arm.impressions * 0.04),
      comments: arm.comments,
      shares: Math.round(arm.impressions * 0.002),
      saves: Math.round(arm.impressions * 0.006),
      samples: 1,
    }));
  }

  private rowFor(
    key: MetricRow['key'],
    label: string,
    hint: string,
    pick: (arm: Arm) => { successes: number; trials: number },
  ): MetricRow {
    const [a, b] = this.arms;
    const countsA = pick(a as Arm);
    const countsB = pick(b as Arm);
    const intervalA = wilsonInterval(countsA.successes, countsA.trials);
    const intervalB = wilsonInterval(countsB.successes, countsB.trials);
    const test =
      countsA.trials > 0 && countsB.trials > 0
        ? twoProportionZTest(countsA.successes, countsA.trials, countsB.successes, countsB.trials)
        : null;
    const rateA = countsA.trials === 0 ? 0 : countsA.successes / countsA.trials;
    const rateB = countsB.trials === 0 ? 0 : countsB.successes / countsB.trials;
    const pValue = test?.pValue ?? 1;
    const leader: ArmId | null =
      countsA.trials === 0 || countsB.trials === 0 || Math.abs(rateA - rateB) < 1e-9 ? null : rateA > rateB ? 'A' : 'B';

    return {
      key,
      label,
      hint,
      a: { rate: rateA, successes: countsA.successes, trials: countsA.trials, lower: intervalA.lower, upper: intervalA.upper },
      b: { rate: rateB, successes: countsB.successes, trials: countsB.trials, lower: intervalB.lower, upper: intervalB.upper },
      lift: rateA === 0 ? 0 : rateB / rateA - 1,
      pValue,
      significant: test !== null && test.pValue < ALPHA,
      leader,
    };
  }

  evaluate(): AbResult {
    const [a, b] = this.arms;
    const aggregates = this.aggregates('24h');
    const primary = evaluateExperiment('exp-kitchen-hook', aggregates, {
      metric: PRIMARY_METRIC,
      window: '24h',
      minSample: MIN_SAMPLE,
      minLift: MIN_LIFT,
      alpha: ALPHA,
    });

    const rows: MetricRow[] = [
      this.rowFor(
        'viewRate3s',
        '3초 유지율',
        '노출 대비 3초 이상 시청한 비율',
        (arm) => ({ successes: arm.views3s, trials: arm.impressions }),
      ),
      this.rowFor(
        'retention',
        '완시율',
        '3초 시청 대비 끝까지 본 비율',
        (arm) => ({ successes: arm.completions, trials: arm.views3s }),
      ),
      this.rowFor(
        'commentRate',
        '댓글률',
        '노출 대비 댓글 수 (쿠폰 트리거의 입구)',
        (arm) => ({ successes: arm.comments, trials: arm.impressions }),
      ),
      this.rowFor(
        'couponRate',
        '쿠폰 전환율',
        '3초 시청 대비 댓글 쿠폰 수령 비율',
        (arm) => ({ successes: arm.couponClaims, trials: arm.views3s }),
      ),
    ];

    const coupon =
      a.views3s > 0 && b.views3s > 0
        ? twoProportionZTest(b.couponClaims, b.views3s, a.couponClaims, a.views3s)
        : { z: 0, pValue: 1, pooledRate: 0, standardError: 0 };

    const ready = a.impressions >= MIN_SAMPLE && b.impressions >= MIN_SAMPLE;
    const winner: ArmId | null =
      ready && primary.status === 'winner' && (primary.winner === 'A' || primary.winner === 'B')
        ? (primary.winner as ArmId)
        : null;

    const notes = [...primary.notes];
    if (ready && primary.status === 'winner' && coupon.pValue >= ALPHA) {
      notes.push(
        `완시율은 유의하지만 쿠폰 전환율은 p=${coupon.pValue.toFixed(3)}로 아직 구분되지 않습니다. 전환까지 확인하려면 표본을 더 모읍니다.`,
      );
    }
    if (!ready) {
      notes.push(`판정 최소 표본은 훅마다 노출 ${MIN_SAMPLE}건입니다(현재 A ${a.impressions} · B ${b.impressions}).`);
    }

    return {
      rows,
      primary,
      coupon,
      winner,
      confidence: primary.confidence,
      requiredSample: Math.ceil(requiredSampleSize(0.35, MIN_LIFT, ALPHA, 0.8)),
      notes,
      ready,
    };
  }

  /** The narration to adopt for the studio hook. */
  textOf(id: ArmId): string {
    return this.arms.find((arm) => arm.id === id)?.text ?? '';
  }
}
