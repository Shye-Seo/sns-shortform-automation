import { describe, expect, it } from 'vitest';
import { HookFeedbackLoop } from '../src/lib/telemetry/feedback';
import { assignVariant, assignmentSpread, bucketOf, generateHookVariants } from '../src/lib/telemetry/hooks';
import { TelemetryIngestor } from '../src/lib/telemetry/metrics';
import {
  erf,
  evaluateExperiment,
  normalCdf,
  normalQuantile,
  requiredSampleSize,
  twoProportionZTest,
  wilsonInterval,
} from '../src/lib/telemetry/significance';
import type { VariantAggregate } from '../src/types/telemetry';

const CAPTURED = '2026-11-11T00:00:00.000Z';

function sample(overrides: Record<string, unknown> & { eventId: string; variantId: string }) {
  return {
    experimentId: 'exp-1',
    platform: 'instagram-reels',
    window: '24h',
    capturedAt: CAPTURED,
    impressions: 1_000,
    views3s: 800,
    watchTimeSec: 6_000,
    completions: 400,
    likes: 40,
    comments: 10,
    shares: 5,
    saves: 20,
    source: 'meta-webhook',
    ...overrides,
  };
}

function aggregate(
  variantId: string,
  counts: { impressions: number; views3s: number; completions: number; comments?: number },
  window: '24h' | '7d' = '24h',
): VariantAggregate {
  const comments = counts.comments ?? Math.round(counts.impressions * 0.01);
  return {
    experimentId: 'exp-1',
    variantId,
    window,
    impressions: counts.impressions,
    views3s: counts.views3s,
    watchTimeSec: counts.views3s * 7,
    completions: counts.completions,
    likes: 0,
    comments,
    shares: 0,
    saves: 0,
    samples: 1,
  };
}

describe('hook variant generation', () => {
  it('builds three distinct-angle variants with fixed A/B/C ids', () => {
    const variants = generateHookVariants('부산 신혼집 3평 주방 수납 정리법');
    expect(variants).toHaveLength(3);
    expect(variants.map((variant) => variant.id)).toEqual(['A', 'B', 'C']);
    expect(new Set(variants.map((variant) => variant.angle)).size).toBe(3);
    for (const variant of variants) {
      expect(variant.hookSeconds).toBeLessThanOrEqual(3.5);
      expect(variant.text.length).toBeGreaterThan(0);
    }
  });

  it('keeps every hook under the 3.5s ceiling even with a long topic', () => {
    const variants = generateHookVariants(
      '결혼하고 신혼집 3평 주방에서 수납을 어떻게 정리해야 하는지 매일 고민하는 사람들을 위한 방법',
      { count: 4 },
    );
    expect(variants).toHaveLength(4);
    for (const variant of variants) expect(variant.hookSeconds).toBeLessThanOrEqual(3.5);
  });

  it('orders the shortlist by feedback weights', () => {
    const variants = generateHookVariants('주방 수납 정리', { weights: { contrarian: 0.9, question: 0.1 } });
    expect(variants[0].angle).toBe('contrarian');
  });

  it('clamps the requested variant count into 2..4', () => {
    expect(generateHookVariants('주방 수납', { count: 1 })).toHaveLength(2);
    expect(generateHookVariants('주방 수납', { count: 9 })).toHaveLength(4);
  });

  it('rejects an empty topic and a single-angle request', () => {
    expect(() => generateHookVariants('   ')).toThrow(/topic/);
    expect(() => generateHookVariants('주방 수납', { angles: ['question'] })).toThrow(/two hook angles/);
  });
});

describe('variant assignment', () => {
  const variants = [{ id: 'A' }, { id: 'B' }, { id: 'C' }];

  it('is deterministic for the same experiment and viewer', () => {
    expect(assignVariant('exp-1', 'viewer-42', variants).id).toBe(assignVariant('exp-1', 'viewer-42', variants).id);
  });

  it('changes with the viewer', () => {
    const seen = new Set(Array.from({ length: 50 }, (_, index) => assignVariant('exp-1', `v${index}`, variants).id));
    expect(seen.size).toBe(3);
  });

  it('returns a bucket in 0..9999', () => {
    for (let index = 0; index < 100; index += 1) {
      const bucket = bucketOf('exp-1', `v${index}`);
      expect(bucket).toBeGreaterThanOrEqual(0);
      expect(bucket).toBeLessThan(10_000);
    }
  });

  it('splits a thousand viewers roughly evenly', () => {
    const spread = assignmentSpread(
      'exp-1',
      Array.from({ length: 1_000 }, (_, index) => `v${index}`),
      ['A', 'B', 'C'],
    );
    for (const entry of spread) {
      expect(entry.share).toBeGreaterThan(0.25);
      expect(entry.share).toBeLessThan(0.42);
    }
    expect(spread.reduce((sum, entry) => sum + entry.count, 0)).toBe(1_000);
  });

  it('refuses an empty variant list', () => {
    expect(() => assignVariant('exp-1', 'v1', [])).toThrow(/empty/);
  });
});

describe('telemetry ingestion', () => {
  it('accepts a sample and rejects a redelivered webhook', () => {
    const ingestor = new TelemetryIngestor();
    const first = ingestor.ingest(sample({ eventId: 'evt-1', variantId: 'A' }));
    expect(first).toMatchObject({ accepted: true, duplicate: false });
    const second = ingestor.ingest(sample({ eventId: 'evt-1', variantId: 'A' }));
    expect(second).toMatchObject({ accepted: false, duplicate: true });
    expect(ingestor.size).toBe(1);
  });

  it('rejects a sample whose 3s views exceed impressions', () => {
    const ingestor = new TelemetryIngestor();
    expect(() =>
      ingestor.ingest(sample({ eventId: 'evt-2', variantId: 'A', impressions: 100, views3s: 150 })),
    ).toThrow();
  });

  it('counts accepted, duplicate and rejected webhooks in a batch', () => {
    const ingestor = new TelemetryIngestor();
    const result = ingestor.ingestMany([
      sample({ eventId: 'e1', variantId: 'A' }),
      sample({ eventId: 'e1', variantId: 'A' }),
      sample({ eventId: 'e2', variantId: 'B' }),
      { eventId: 'bad' },
    ]);
    expect(result).toEqual({ accepted: 2, duplicates: 1, rejected: 1 });
  });

  it('sums samples per variant and window', () => {
    const ingestor = new TelemetryIngestor();
    ingestor.ingest(sample({ eventId: 'e1', variantId: 'A', impressions: 1_000, views3s: 800, completions: 400 }));
    ingestor.ingest(sample({ eventId: 'e2', variantId: 'A', impressions: 500, views3s: 300, completions: 100 }));
    ingestor.ingest(sample({ eventId: 'e3', variantId: 'A', window: '7d', impressions: 9_999, views3s: 9_999, completions: 1 }));

    const daily = ingestor.aggregate('exp-1', '24h');
    expect(daily).toHaveLength(1);
    expect(daily[0]).toMatchObject({ impressions: 1_500, views3s: 1_100, completions: 500, samples: 2 });
    expect(ingestor.aggregate('exp-1', '7d')).toHaveLength(1);
  });

  it('derives rates, average watch time and engagement', () => {
    const ingestor = new TelemetryIngestor();
    ingestor.ingest(
      sample({
        eventId: 'e1',
        variantId: 'A',
        impressions: 2_000,
        views3s: 1_000,
        watchTimeSec: 10_000,
        completions: 500,
        likes: 100,
        comments: 50,
        shares: 20,
        saves: 30,
      }),
    );
    const [metrics] = ingestor.metrics('exp-1', '24h');
    expect(metrics).toMatchObject({
      variantId: 'A',
      viewRate3s: 0.5,
      retention: 0.5,
      avgWatchSec: 10,
      commentRate: 0.025,
      engagementRate: 0.1,
    });
  });

  it('lists the experiments it has data for', () => {
    const ingestor = new TelemetryIngestor();
    ingestor.ingest(sample({ eventId: 'e1', variantId: 'A' }));
    ingestor.ingest(sample({ eventId: 'e2', variantId: 'B' }));
    expect(ingestor.experiments()).toEqual([{ experimentId: 'exp-1', samples: 2, variants: ['A', 'B'] }]);
  });

  it('handles an empty ingestor without dividing by zero', () => {
    const ingestor = new TelemetryIngestor();
    expect(ingestor.aggregate('exp-1', '24h')).toEqual([]);
    expect(ingestor.metrics('exp-1', '24h')).toEqual([]);
    expect(ingestor.latestCapturedAt()).toBeNull();
  });
});

describe('statistics', () => {
  it('matches known normal values', () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 6);
    expect(normalCdf(1.96)).toBeCloseTo(0.975, 3);
    expect(normalQuantile(0.975)).toBeCloseTo(1.95996, 4);
    expect(normalQuantile(0.5)).toBeCloseTo(0, 6);
    expect(normalQuantile(0.8)).toBeCloseTo(0.8416, 3);
    expect(erf(0)).toBeCloseTo(0, 6);
    expect(erf(1)).toBeCloseTo(0.8427, 3);
  });

  it('computes a two-proportion z-test', () => {
    const result = twoProportionZTest(500, 1_000, 400, 1_000);
    expect(result.z).toBeCloseTo(4.495, 2);
    expect(result.pValue).toBeLessThan(0.001);
    expect(twoProportionZTest(500, 1_000, 500, 1_000).pValue).toBeCloseTo(1, 6);
  });

  it('brackets a proportion with a Wilson interval', () => {
    const interval = wilsonInterval(50, 100);
    expect(interval.lower).toBeLessThan(0.5);
    expect(interval.upper).toBeGreaterThan(0.5);
    expect(interval.lower).toBeGreaterThan(0.39);
    expect(interval.upper).toBeLessThan(0.61);
    expect(wilsonInterval(0, 0)).toEqual({ lower: 0, upper: 0, center: 0 });
  });

  it('needs more samples for a smaller effect', () => {
    const coarse = requiredSampleSize(0.4, 0.2);
    const fine = requiredSampleSize(0.4, 0.05);
    expect(fine).toBeGreaterThan(coarse);
    expect(coarse).toBeGreaterThan(0);
  });

  it('rejects impossible inputs', () => {
    expect(() => requiredSampleSize(0, 0.1)).toThrow(/between 0 and 1/);
    expect(() => requiredSampleSize(0.4, 0)).toThrow(/positive/);
    expect(() => normalQuantile(1)).toThrow(/0 < p < 1/);
  });
});

describe('experiment evaluation', () => {
  it('reports insufficient data before the sample floor', () => {
    const result = evaluateExperiment('exp-1', [
      aggregate('A', { impressions: 100, views3s: 80, completions: 40 }),
      aggregate('B', { impressions: 100, views3s: 80, completions: 44 }),
    ]);
    expect(result.status).toBe('insufficient-data');
    expect(result.winner).toBeNull();
    expect(result.notes[0]).toMatch(/insufficient sample/);
  });

  it('reports insufficient data with fewer than two variants', () => {
    const result = evaluateExperiment('exp-1', [aggregate('A', { impressions: 5_000, views3s: 4_000, completions: 2_000 })]);
    expect(result.status).toBe('insufficient-data');
    expect(result.variants).toEqual([]);
  });

  it('declares a winner when the leader clears both significance and lift', () => {
    const result = evaluateExperiment('exp-1', [
      aggregate('A', { impressions: 2_000, views3s: 1_600, completions: 800 }),
      aggregate('B', { impressions: 2_000, views3s: 1_600, completions: 1_100 }),
    ]);
    expect(result.status).toBe('winner');
    expect(result.winner).toBe('B');
    expect(result.confidence).toBeGreaterThan(0.95);
    expect(result.variants[0].variantId).toBe('B');
    expect(result.variants[0].lift).toBeGreaterThan(0.3);
  });

  it('stays inconclusive when the difference is noise', () => {
    const result = evaluateExperiment('exp-1', [
      aggregate('A', { impressions: 2_000, views3s: 1_600, completions: 800 }),
      aggregate('B', { impressions: 2_000, views3s: 1_600, completions: 812 }),
    ]);
    expect(result.status).toBe('inconclusive');
    expect(result.winner).toBeNull();
  });

  it('refuses to call a statistically significant but immaterial lift', () => {
    const result = evaluateExperiment('exp-1', [
      aggregate('A', { impressions: 200_000, views3s: 200_000, completions: 100_000 }),
      aggregate('B', { impressions: 200_000, views3s: 200_000, completions: 100_800 }),
    ]);
    expect(result.status).toBe('inconclusive');
    expect(result.notes.join(' ')).toMatch(/below the 5% floor/);
  });

  it('evaluates 7-day retention from the 7d window only', () => {
    const aggregates = [
      aggregate('A', { impressions: 2_000, views3s: 1_600, completions: 800 }, '24h'),
      aggregate('A', { impressions: 2_000, views3s: 1_600, completions: 800 }, '7d'),
      aggregate('B', { impressions: 2_000, views3s: 1_600, completions: 1_100 }, '7d'),
    ];
    const result = evaluateExperiment('exp-1', aggregates, { window: '7d' });
    expect(result.window).toBe('7d');
    expect(result.status).toBe('winner');
    expect(result.variants).toHaveLength(2);
  });

  it('supports the 3-second view-rate metric', () => {
    const result = evaluateExperiment(
      'exp-1',
      [
        aggregate('A', { impressions: 2_000, views3s: 1_000, completions: 400 }),
        aggregate('B', { impressions: 2_000, views3s: 1_400, completions: 400 }),
      ],
      { metric: 'viewRate3s' },
    );
    expect(result.metric).toBe('viewRate3s');
    expect(result.winner).toBe('B');
  });

  it('rejects an invalid alpha', () => {
    expect(() =>
      evaluateExperiment('exp-1', [aggregate('A', { impressions: 1, views3s: 1, completions: 1 })], { alpha: 0 }),
    ).toThrow(/alpha/);
  });
});

describe('hook feedback loop', () => {
  it('starts uniform across all six angles', () => {
    const loop = new HookFeedbackLoop();
    const weights = loop.weights();
    expect(Object.keys(weights)).toHaveLength(6);
    for (const weight of Object.values(weights)) expect(weight).toBeCloseTo(1 / 6, 2);
    expect(Object.values(weights).reduce((sum, weight) => sum + weight, 0)).toBeCloseTo(1, 2);
  });

  it('shifts weight toward the winning angle while keeping exploration', () => {
    const variants = generateHookVariants('주방 수납 정리', { count: 3 });
    const evaluation = evaluateExperiment('exp-1', [
      aggregate(variants[0].id, { impressions: 5_000, views3s: 4_000, completions: 2_000 }),
      aggregate(variants[1].id, { impressions: 5_000, views3s: 4_000, completions: 2_900 }),
      aggregate(variants[2].id, { impressions: 5_000, views3s: 4_000, completions: 2_100 }),
    ]);
    expect(evaluation.status).toBe('winner');

    const loop = new HookFeedbackLoop();
    loop.update(evaluation, variants);
    const ranked = loop.rankAngles();
    const winnerAngle = variants.find((variant) => variant.id === evaluation.winner)!.angle;
    expect(ranked[0].angle).toBe(winnerAngle);
    expect(ranked[0].weight).toBeGreaterThan(0.25);
    expect(ranked[ranked.length - 1].weight).toBeGreaterThan(0.01);
    expect(ranked.reduce((sum, entry) => sum + entry.weight, 0)).toBeCloseTo(1, 2);
  });

  it('ignores an experiment without enough data', () => {
    const variants = generateHookVariants('주방 수납', { count: 2 });
    const evaluation = evaluateExperiment('exp-1', [
      aggregate(variants[0].id, { impressions: 10, views3s: 8, completions: 4 }),
      aggregate(variants[1].id, { impressions: 10, views3s: 8, completions: 4 }),
    ]);
    const loop = new HookFeedbackLoop();
    loop.update(evaluation, variants);
    expect(loop.rankAngles().every((entry) => entry.trials === 0)).toBe(true);
  });

  it('chooses the highest-weighted angle deterministically at random=0', () => {
    const variants = generateHookVariants('주방 수납 정리', { count: 3 });
    const evaluation = evaluateExperiment('exp-1', [
      aggregate(variants[0].id, { impressions: 5_000, views3s: 4_000, completions: 2_000 }),
      aggregate(variants[1].id, { impressions: 5_000, views3s: 4_000, completions: 3_000 }),
      aggregate(variants[2].id, { impressions: 5_000, views3s: 4_000, completions: 2_000 }),
    ]);
    const loop = new HookFeedbackLoop();
    loop.update(evaluation, variants);
    expect(loop.choose(() => 0)).toBe(loop.rankAngles()[0].angle);
    expect(loop.choose(() => 0.999)).toBe(loop.rankAngles().at(-1)!.angle);
  });

  it('resets back to cold start', () => {
    const loop = new HookFeedbackLoop();
    const weights = loop.weights();
    loop.reset();
    expect(loop.weights()).toEqual(weights);
  });
});
