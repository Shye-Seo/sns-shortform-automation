import {
  HookAngleSchema,
  type ExperimentEvaluation,
  type HookAngle,
  type HookVariant,
} from '../../types/telemetry';

export interface AngleStats {
  angle: HookAngle;
  wins: number;
  trials: number;
  /** Shrunk mean lift over the control; 0 at cold start, negative when behind. */
  score: number;
  /** Share of the next generation budget, 0–1, sums to 1. */
  weight: number;
  averageLift: number;
}

export interface HookFeedbackOptions {
  /** Pseudo-observations pulling an underexposed angle toward zero lift. */
  priorStrength?: number;
  /** Every angle keeps a floor so a bad week cannot kill it permanently. */
  explorationFloor?: number;
  /** Softmax temperature over lift; smaller = more ruthless. */
  temperature?: number;
}

/**
 * The feedback edge of the loop: experiment result → next script's hook.
 *
 * Scoring uses each variant's lift over the control, not its win rate. With a
 * win rate a tested loser scores 0.4 while an untested angle scores 0.5, so
 * losing angles would outrank untested ones forever. Lift (shrunk toward zero)
 * keeps the ordering honest: winner > untested > loser.
 *
 * Weights are a softmax over those scores plus an exploration floor, so the
 * next generation runs ~35/15/15 rather than 100/0 and the loop keeps learning.
 */
export class HookFeedbackLoop {
  private readonly priorStrength: number;
  private readonly explorationFloor: number;
  private readonly temperature: number;
  private readonly stats = new Map<HookAngle, { wins: number; trials: number; liftSum: number }>();

  constructor(options: HookFeedbackOptions = {}) {
    this.priorStrength = Math.max(1, options.priorStrength ?? 4);
    this.explorationFloor = Math.min(0.5, Math.max(0, options.explorationFloor ?? 0.08));
    this.temperature = Math.max(0.01, options.temperature ?? 0.1);
  }

  private entry(angle: HookAngle): { wins: number; trials: number; liftSum: number } {
    const existing = this.stats.get(angle);
    if (existing) return existing;
    const created = { wins: 0, trials: 0, liftSum: 0 };
    this.stats.set(angle, created);
    return created;
  }

  /** Fold one concluded experiment into the angle statistics. */
  update(evaluation: ExperimentEvaluation, variants: HookVariant[]): void {
    if (evaluation.status === 'insufficient-data') return;
    const angleOf = new Map(variants.map((variant) => [variant.id, variant.angle]));
    for (const score of evaluation.variants) {
      const angle = angleOf.get(score.variantId);
      if (!angle) continue;
      const entry = this.entry(angle);
      entry.trials += 1;
      entry.liftSum += score.lift;
    }
    if (evaluation.status === 'winner' && evaluation.winner) {
      const angle = angleOf.get(evaluation.winner);
      if (angle) this.entry(angle).wins += 1;
    }
  }

  rankAngles(): AngleStats[] {
    const angles = HookAngleSchema.options;
    const scored = angles.map((angle) => {
      const entry = this.stats.get(angle) ?? { wins: 0, trials: 0, liftSum: 0 };
      const score = entry.liftSum / (entry.trials + this.priorStrength);
      return {
        angle,
        wins: entry.wins,
        trials: entry.trials,
        score: Math.round(score * 10_000) / 10_000,
        weight: 0,
        averageLift: entry.trials === 0 ? 0 : Math.round((entry.liftSum / entry.trials) * 10_000) / 10_000,
      } satisfies AngleStats;
    });
    const best = Math.max(...scored.map((entry) => entry.score));
    const exps = scored.map((entry) => Math.exp((entry.score - best) / this.temperature));
    const total = exps.reduce((sum, value) => sum + value, 0);
    scored.forEach((entry, index) => {
      const share = exps[index] / total;
      entry.weight = Math.round((this.explorationFloor / scored.length + (1 - this.explorationFloor) * share) * 10_000) / 10_000;
    });
    return scored.sort((a, b) => b.weight - a.weight);
  }

  weights(): Record<HookAngle, number> {
    const map = {} as Record<HookAngle, number>;
    for (const entry of this.rankAngles()) map[entry.angle] = entry.weight;
    return map;
  }

  /** Weighted draw for the next hook generation. */
  choose(random: () => number = Math.random): HookAngle {
    const ranked = this.rankAngles();
    const target = random();
    let cumulative = 0;
    for (const entry of ranked) {
      cumulative += entry.weight;
      if (target <= cumulative) return entry.angle;
    }
    return ranked[ranked.length - 1].angle;
  }

  reset(): void {
    this.stats.clear();
  }
}
