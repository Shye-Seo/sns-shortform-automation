import { ShortformError } from '../errors';
import type {
  ExperimentEvaluation,
  MetricWindow,
  ProportionMetric,
  VariantAggregate,
  VariantScore,
} from '../../types/telemetry';
import { deriveMetrics } from './metrics';

/* ── normal distribution helpers ─────────────────────────────────────────
 * Kept dependency-free on purpose: a portfolio repo should not add a stats
 * package to compute one p-value, and the approximations below are accurate
 * to ~1e-7, far beyond what a 200-view sample justifies.
 * --------------------------------------------------------------------- */

/** Abramowitz & Stegun 7.1.26, |error| < 1.5e-7. */
export function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const value = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * value);
  const poly =
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t;
  return sign * (1 - poly * Math.exp(-value * value));
}

export function normalCdf(z: number): number {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

/** Acklam's inverse normal CDF, |error| < 1.15e-9 in the central region. */
export function normalQuantile(p: number): number {
  if (!(p > 0 && p < 1)) {
    throw new ShortformError('normalQuantile requires 0 < p < 1', { code: 'VALIDATION', details: { p } });
  }
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pLow = 0.02425;
  const pHigh = 1 - pLow;
  let q: number;

  if (p < pLow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > pHigh) {
    q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  q = p - 0.5;
  const r = q * q;
  return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

export interface ProportionTest {
  z: number;
  pValue: number;
  pooledRate: number;
  standardError: number;
}

/**
 * Two-sided two-proportion z-test. Used only to compare the leader against the
 * runner-up: testing every pair and reporting the best p-value is how A/B
 * dashboards manufacture false winners.
 */
export function twoProportionZTest(
  successesA: number,
  trialsA: number,
  successesB: number,
  trialsB: number,
): ProportionTest {
  if (trialsA <= 0 || trialsB <= 0) {
    throw new ShortformError('both variants need at least one trial', {
      code: 'VALIDATION',
      details: { trialsA, trialsB },
    });
  }
  const pooled = (successesA + successesB) / (trialsA + trialsB);
  const standardError = Math.sqrt(pooled * (1 - pooled) * (1 / trialsA + 1 / trialsB));
  if (standardError === 0) {
    return { z: 0, pValue: 1, pooledRate: pooled, standardError: 0 };
  }
  const z = (successesA / trialsA - successesB / trialsB) / standardError;
  return {
    z,
    pValue: Math.max(0, Math.min(1, 2 * (1 - normalCdf(Math.abs(z))))),
    pooledRate: pooled,
    standardError,
  };
}

/** Wilson score interval — correct at the small samples a new episode has. */
export function wilsonInterval(
  successes: number,
  trials: number,
  z = 1.959963985,
): { lower: number; upper: number; center: number } {
  if (trials <= 0) return { lower: 0, upper: 0, center: 0 };
  const p = successes / trials;
  const denominator = 1 + (z * z) / trials;
  const center = (p + (z * z) / (2 * trials)) / denominator;
  const margin = (z * Math.sqrt((p * (1 - p)) / trials + (z * z) / (4 * trials * trials))) / denominator;
  return {
    lower: Math.max(0, Math.round((center - margin) * 10_000) / 10_000),
    upper: Math.min(1, Math.round((center + margin) * 10_000) / 10_000),
    center: Math.round(center * 10_000) / 10_000,
  };
}

/**
 * Views per variant needed to detect a relative lift, at the given alpha and
 * power. This is the number that stops a team from calling a winner on 80 views.
 */
export function requiredSampleSize(
  baseline: number,
  mdeRelative: number,
  alpha = 0.05,
  power = 0.8,
): number {
  if (!(baseline > 0 && baseline < 1)) {
    throw new ShortformError('baseline rate must be between 0 and 1', {
      code: 'VALIDATION',
      details: { baseline },
    });
  }
  if (!(mdeRelative > 0)) {
    throw new ShortformError('minimum detectable effect must be positive', {
      code: 'VALIDATION',
      details: { mdeRelative },
    });
  }
  const p1 = baseline;
  const p2 = Math.min(0.999, baseline * (1 + mdeRelative));
  const pBar = (p1 + p2) / 2;
  const zAlpha = normalQuantile(1 - alpha / 2);
  const zPower = normalQuantile(power);
  const numerator =
    zAlpha * Math.sqrt(2 * pBar * (1 - pBar)) + zPower * Math.sqrt(p1 * (1 - p1) + p2 * (1 - p2));
  return Math.ceil((numerator * numerator) / ((p2 - p1) * (p2 - p1)));
}

export interface EvaluateOptions {
  metric?: ProportionMetric;
  window?: MetricWindow;
  /** Minimum trials (impressions or 3s views) per variant. */
  minSample?: number;
  /** Minimum relative lift over the runner-up to be called a winner. */
  minLift?: number;
  alpha?: number;
}

interface Counts {
  successes: number;
  trials: number;
}

function countsFor(aggregate: VariantAggregate, metric: ProportionMetric): Counts {
  switch (metric) {
    case 'viewRate3s':
      return { successes: aggregate.views3s, trials: aggregate.impressions };
    case 'retention':
      return { successes: aggregate.completions, trials: aggregate.views3s };
    case 'commentRate':
      return { successes: aggregate.comments, trials: aggregate.impressions };
    default: {
      const unreachable: never = metric;
      throw new ShortformError(`unknown metric: ${String(unreachable)}`, { code: 'VALIDATION' });
    }
  }
}

/**
 * Decide whether an experiment has a winner.
 *
 * Deliberate conservatism:
 *  - `insufficient-data` until every variant clears `minSample`, because the
 *    first 100 views belong to the algorithm shuffling, not to the hook.
 *  - leader vs runner-up only, so three variants cannot produce a "winner"
 *    by multiple comparisons.
 *  - a winner needs both statistical significance and a minimum lift: a
 *    0.4pp win at n=100k is real and useless.
 */
export function evaluateExperiment(
  experimentId: string,
  aggregates: VariantAggregate[],
  options: EvaluateOptions = {},
): ExperimentEvaluation {
  const metric = options.metric ?? 'retention';
  const window = options.window ?? '24h';
  const minSample = options.minSample ?? 200;
  const minLift = options.minLift ?? 0.05;
  const alpha = options.alpha ?? 0.05;
  if (!(alpha > 0 && alpha < 1)) {
    throw new ShortformError('alpha must be between 0 and 1', { code: 'VALIDATION', details: { alpha } });
  }

  const relevant = aggregates.filter((aggregate) => aggregate.window === window);
  const scores: VariantScore[] = [];
  const notes: string[] = [];

  if (relevant.length < 2) {
    return {
      experimentId,
      metric,
      window,
      status: 'insufficient-data',
      winner: null,
      confidence: 0,
      alpha,
      requiredSample: 0,
      variants: scores,
      notes: ['need at least two variants with data in this window'],
    };
  }

  const withCounts = relevant.map((aggregate) => ({
    aggregate,
    counts: countsFor(aggregate, metric),
    metrics: deriveMetrics(aggregate),
  }));
  const control = withCounts[0];
  const controlRate = control.counts.trials === 0 ? 0 : control.counts.successes / control.counts.trials;

  for (const entry of withCounts) {
    const rate = entry.counts.trials === 0 ? 0 : entry.counts.successes / entry.counts.trials;
    const interval = wilsonInterval(entry.counts.successes, entry.counts.trials);
    scores.push({
      variantId: entry.aggregate.variantId,
      value: Math.round(rate * 10_000) / 10_000,
      successes: entry.counts.successes,
      trials: entry.counts.trials,
      lower: interval.lower,
      upper: interval.upper,
      lift: controlRate === 0 ? 0 : Math.round((rate / controlRate - 1) * 10_000) / 10_000,
      pValue: 1,
    });
  }

  const underpowered = withCounts.filter((entry) => entry.counts.trials < minSample);
  if (underpowered.length > 0) {
    notes.push(
      `insufficient sample: ${underpowered
        .map((entry) => `${entry.aggregate.variantId}=${entry.counts.trials}`)
        .join(', ')} < ${minSample} ${metric === 'retention' ? '3s views' : 'impressions'}`,
    );
    return {
      experimentId,
      metric,
      window,
      status: 'insufficient-data',
      winner: null,
      confidence: 0,
      alpha,
      requiredSample: Math.ceil(requiredSampleSize(Math.max(0.01, controlRate), minLift, alpha, 0.8)),
      variants: scores,
      notes,
    };
  }

  const ranked = [...withCounts].sort((a, b) => {
    const rateA = a.counts.trials === 0 ? 0 : a.counts.successes / a.counts.trials;
    const rateB = b.counts.trials === 0 ? 0 : b.counts.successes / b.counts.trials;
    return rateB - rateA;
  });
  const leader = ranked[0];
  const runnerUp = ranked[1];
  const test = twoProportionZTest(
    leader.counts.successes,
    leader.counts.trials,
    runnerUp.counts.successes,
    runnerUp.counts.trials,
  );
  const leaderRate = leader.counts.successes / leader.counts.trials;
  const runnerRate = runnerUp.counts.successes / runnerUp.counts.trials;
  const lift = runnerRate === 0 ? 0 : leaderRate / runnerRate - 1;

  for (const score of scores) {
    if (score.variantId === leader.aggregate.variantId) {
      score.pValue = Math.round(test.pValue * 1_000_000) / 1_000_000;
    }
  }

  // Each variant also gets a p-value against the control, which is what an
  // operator reads row by row. The winner decision above still uses the
  // conservative leader-vs-runner comparison.
  for (const score of scores) {
    const entry = withCounts.find((candidate) => candidate.aggregate.variantId === score.variantId);
    if (!entry || score.variantId === control.aggregate.variantId || control.counts.trials === 0) continue;
    const vsControl = twoProportionZTest(
      entry.counts.successes,
      entry.counts.trials,
      control.counts.successes,
      control.counts.trials,
    );
    score.pValue = Math.round(vsControl.pValue * 1_000_000) / 1_000_000;
  }

  const significant = test.pValue < alpha;
  const material = lift >= minLift;
  if (!significant) notes.push(`p=${test.pValue.toFixed(4)} is above alpha=${alpha}`);
  if (!material) notes.push(`lift ${(lift * 100).toFixed(1)}% is below the ${(minLift * 100).toFixed(0)}% floor`);

  return {
    experimentId,
    metric,
    window,
    status: significant && material ? 'winner' : 'inconclusive',
    winner: significant && material ? leader.aggregate.variantId : null,
    confidence: Math.round((1 - test.pValue) * 10_000) / 10_000,
    alpha,
    requiredSample: Math.ceil(requiredSampleSize(Math.max(0.01, runnerRate || 0.01), minLift, alpha, 0.8)),
    variants: scores.sort((a, b) => b.value - a.value),
    notes,
  };
}
