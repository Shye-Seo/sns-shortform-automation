import {
  MetricSampleSchema,
  type MetricSample,
  type MetricWindow,
  type VariantAggregate,
  type VariantMetrics,
} from '../../types/telemetry';

export interface IngestResult {
  accepted: boolean;
  duplicate: boolean;
  sample: MetricSample;
}

const round4 = (value: number): number => Math.round(value * 10_000) / 10_000;

/**
 * Webhook ingestion for hook performance.
 *
 * Two rules make this a pipeline rather than a counter:
 *  1. `eventId` is unique — Meta retries webhooks, and a naive counter would
 *     inflate the winning variant by however many retries it happened to get.
 *  2. Samples are additive across the window. A late 24h sample and a 7d
 *     sample are different observations; they are never summed together.
 */
export class TelemetryIngestor {
  private readonly byEvent = new Map<string, MetricSample>();
  private readonly now: () => number;

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
  }

  get size(): number {
    return this.byEvent.size;
  }

  ingest(payload: unknown): IngestResult {
    const parsed = MetricSampleSchema.parse(payload);
    const existing = this.byEvent.get(parsed.eventId);
    if (existing) {
      return { accepted: false, duplicate: true, sample: existing };
    }
    this.byEvent.set(parsed.eventId, parsed);
    return { accepted: true, duplicate: false, sample: parsed };
  }

  ingestMany(payloads: unknown[]): { accepted: number; duplicates: number; rejected: number } {
    let accepted = 0;
    let duplicates = 0;
    let rejected = 0;
    for (const payload of payloads) {
      try {
        const result = this.ingest(payload);
        if (result.accepted) accepted += 1;
        else duplicates += 1;
      } catch {
        rejected += 1;
      }
    }
    return { accepted, duplicates, rejected };
  }

  samplesFor(experimentId: string): MetricSample[] {
    return [...this.byEvent.values()].filter((sample) => sample.experimentId === experimentId);
  }

  aggregate(experimentId: string, window: MetricWindow): VariantAggregate[] {
    const totals = new Map<string, VariantAggregate>();
    for (const sample of this.byEvent.values()) {
      if (sample.experimentId !== experimentId || sample.window !== window) continue;
      const current =
        totals.get(sample.variantId) ??
        ({
          experimentId,
          variantId: sample.variantId,
          window,
          impressions: 0,
          views3s: 0,
          watchTimeSec: 0,
          completions: 0,
          likes: 0,
          comments: 0,
          shares: 0,
          saves: 0,
          samples: 0,
        } satisfies VariantAggregate);
      current.impressions += sample.impressions;
      current.views3s += sample.views3s;
      current.watchTimeSec += sample.watchTimeSec;
      current.completions += sample.completions;
      current.likes += sample.likes;
      current.comments += sample.comments;
      current.shares += sample.shares;
      current.saves += sample.saves;
      current.samples += 1;
      totals.set(sample.variantId, current);
    }
    return [...totals.values()].sort((a, b) => a.variantId.localeCompare(b.variantId));
  }

  metrics(experimentId: string, window: MetricWindow): VariantMetrics[] {
    return this.aggregate(experimentId, window).map(deriveMetrics);
  }

  /** Snapshot for the console/API: which experiments have data, and how much. */
  experiments(): Array<{ experimentId: string; samples: number; variants: string[] }> {
    const map = new Map<string, { samples: number; variants: Set<string> }>();
    for (const sample of this.byEvent.values()) {
      const entry = map.get(sample.experimentId) ?? { samples: 0, variants: new Set<string>() };
      entry.samples += 1;
      entry.variants.add(sample.variantId);
      map.set(sample.experimentId, entry);
    }
    return [...map.entries()].map(([experimentId, entry]) => ({
      experimentId,
      samples: entry.samples,
      variants: [...entry.variants].sort(),
    }));
  }

  clear(): void {
    this.byEvent.clear();
  }

  /** Used to stamp "last ingested" in the console without leaking payloads. */
  latestCapturedAt(): string | null {
    let latest: number | null = null;
    for (const sample of this.byEvent.values()) {
      const at = Date.parse(sample.capturedAt);
      if (Number.isFinite(at) && (latest === null || at > latest)) latest = at;
    }
    return latest === null ? null : new Date(Math.min(latest, this.now())).toISOString();
  }
}

export function deriveMetrics(aggregate: VariantAggregate): VariantMetrics {
  const impressions = aggregate.impressions;
  const views = aggregate.views3s;
  return {
    variantId: aggregate.variantId,
    window: aggregate.window,
    samples: aggregate.samples,
    impressions,
    viewRate3s: impressions === 0 ? 0 : round4(views / impressions),
    retention: views === 0 ? 0 : round4(aggregate.completions / views),
    avgWatchSec: views === 0 ? 0 : round4(aggregate.watchTimeSec / views),
    commentRate: impressions === 0 ? 0 : round4(aggregate.comments / impressions),
    engagementRate:
      impressions === 0
        ? 0
        : round4((aggregate.likes + aggregate.comments + aggregate.shares + aggregate.saves) / impressions),
  };
}
