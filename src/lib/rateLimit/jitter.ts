import { ShortformError } from '../errors';

export interface PublishSlotRequest {
  count: number;
  windowStartMs: number;
  windowEndMs: number;
  /**
   * Minimum spacing between two publishes. 45 minutes is deliberate: a burst
   * of six posts inside four minutes is the pattern that reads as a bot.
   */
  minGapMs?: number;
  /** Keep the first slot at least this far from `now` (upload/review slack). */
  leadMs?: number;
  /** Push slots off whole-minute boundaries (schedulers wake on the minute). */
  guardMs?: number;
  random?: () => number;
}

export interface PublishSlot {
  index: number;
  atMs: number;
  iso: string;
  /** Position within the window, 0–1. */
  offsetRatio: number;
  gapVsPrevMs: number;
}

export interface GapStatistics {
  count: number;
  meanGapMs: number;
  stdevGapMs: number;
  minGapMs: number;
  maxGapMs: number;
  /** stdev / mean. 0 = perfectly regular (and therefore machine-like). */
  spreadRatio: number;
}

/**
 * Spread `count` publishes across a window with per-slot jitter.
 *
 * The naive scheduler publishes at 09:00:00, 10:00:00, 11:00:00 — identical
 * second offsets every day. Platforms score account behaviour partly on that
 * regularity. Bucket-random placement inside the window keeps every slot on
 * schedule while removing the fingerprint, and the guard keeps slots off the
 * minute grid the scheduler itself uses.
 */
export function planPublishSlots(request: PublishSlotRequest): PublishSlot[] {
  const count = Math.floor(request.count);
  if (!Number.isFinite(count) || count < 1) {
    throw new ShortformError('slot count must be >= 1', { code: 'VALIDATION', details: { count } });
  }
  if (!(request.windowEndMs > request.windowStartMs)) {
    throw new ShortformError('publish window must end after it starts', {
      code: 'VALIDATION',
      details: { windowStartMs: request.windowStartMs, windowEndMs: request.windowEndMs },
    });
  }
  const random = request.random ?? Math.random;
  const leadMs = Math.max(0, request.leadMs ?? 0);
  const guardMs = Math.max(0, request.guardMs ?? 15_000);
  const start = request.windowStartMs + leadMs;
  // Leave the guard (and 1s) of headroom so a grid nudge never exits the window.
  const end = request.windowEndMs - guardMs - 1_000;
  const span = end - start;
  if (span <= 0) {
    throw new ShortformError('publish window is consumed by the lead time', {
      code: 'VALIDATION',
      details: { leadMs, windowMs: request.windowEndMs - request.windowStartMs },
    });
  }
  const gapCount = count - 1;
  const defaultGap = Math.min(60 * 60 * 1_000, span / Math.max(2, count * 2));
  const minGap = Math.max(0, request.minGapMs ?? defaultGap);
  if (gapCount > 0 && minGap * gapCount > span) {
    throw new ShortformError('window cannot fit the requested slots at the minimum gap', {
      code: 'VALIDATION',
      details: {
        count,
        windowMin: Math.round((request.windowEndMs - request.windowStartMs) / 60_000),
        minGapMin: Math.round(minGap / 60_000),
        neededMin: Math.round((minGap * gapCount) / 60_000),
      },
    });
  }
  /**
   * Gaps = minimum + a random share of the leftover slack, normalised so the
   * plan exactly fills the window. Sampling a point inside each fixed bucket
   * (the obvious approach) degenerates when the bucket is barely wider than
   * the minimum gap: most draws fall below `prev + minGap` and get clamped,
   * producing identical 120-minute gaps — the same fingerprint the jitter was
   * meant to remove.
   */
  const slack = Math.max(0, span - minGap * gapCount);
  // Do not always finish on the window edge: leave a random tail so the last
  // publish is not pinned to 22:59:44 every single day.
  const tail = Math.min(60 * 60 * 1_000, slack * 0.5) * random() * 0.5;
  const effectiveSlack = Math.max(0, slack - tail);
  // A random offset for the first slot too: pinning it to the window start
  // would make every day's first publish land at exactly 09:00.
  const leadJitter = Math.min(90 * 60 * 1_000, effectiveSlack * 0.4) * random();
  const remainingSlack = Math.max(0, effectiveSlack - leadJitter);
  // Exponential weights: a uniform 0.5–1.5 draw compresses into a nearly
  // regular cadence after normalisation, which defeats the point.
  const weights = Array.from({ length: gapCount }, () =>
    Math.max(0.02, -Math.log(1 - Math.min(0.999, random()))),
  );
  const weightSum = weights.reduce((sum, weight) => sum + weight, 0) || 1;
  const gaps = weights.map((weight) => minGap + (remainingSlack * weight) / weightSum);

  const slots: PublishSlot[] = [];
  let cursor = start + leadJitter;
  for (let index = 0; index < count; index += 1) {
    if (index > 0) cursor += gaps[index - 1];
    let at = Math.min(Math.max(cursor, start), end);
    // Grid guard: schedulers wake on the minute, so do not look like one.
    if (guardMs > 0 && at % 60_000 < guardMs) at = Math.min(end, at + guardMs);
    const rounded = Math.round(at);
    const gapVsPrevMs = index === 0 ? 0 : rounded - slots[index - 1].atMs;
    if (index > 0 && gapVsPrevMs < minGap) {
      throw new ShortformError('slot planner produced an undersized gap', {
        code: 'VALIDATION',
        details: { index, gapMs: gapVsPrevMs, minGapMs: minGap },
      });
    }
    slots.push({
      index,
      atMs: rounded,
      iso: new Date(rounded).toISOString(),
      offsetRatio:
        Math.round(((rounded - request.windowStartMs) / (request.windowEndMs - request.windowStartMs)) * 10_000) /
        10_000,
      gapVsPrevMs,
    });
  }

  if (slots[slots.length - 1].atMs > request.windowEndMs) {
    throw new ShortformError('slot planner produced a slot past the window end', {
      code: 'VALIDATION',
      details: { lastSlot: slots[slots.length - 1].iso, windowEndMs: request.windowEndMs },
    });
  }
  return slots;
}

/** Jitter for a single scheduled action: never earlier than `baseMs - spread`. */
export function jitteredDelay(baseMs: number, ratio: number, random: () => number = Math.random): number {
  const safeBase = Math.max(0, baseMs);
  const safeRatio = Math.min(1, Math.max(0, ratio));
  const spread = safeBase * safeRatio;
  return Math.round(safeBase - spread + random() * spread);
}

/** Report the spacing so an operator can see the plan is actually irregular. */
export function gapStatistics(slots: PublishSlot[]): GapStatistics {
  const gaps = slots.slice(1).map((slot) => slot.atMs - slots[slot.index - 1].atMs);
  if (gaps.length === 0) {
    return { count: slots.length, meanGapMs: 0, stdevGapMs: 0, minGapMs: 0, maxGapMs: 0, spreadRatio: 0 };
  }
  const mean = gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length;
  const variance = gaps.reduce((sum, gap) => sum + (gap - mean) ** 2, 0) / gaps.length;
  const stdev = Math.sqrt(variance);
  return {
    count: slots.length,
    meanGapMs: Math.round(mean),
    stdevGapMs: Math.round(stdev),
    minGapMs: Math.min(...gaps),
    maxGapMs: Math.max(...gaps),
    spreadRatio: mean === 0 ? 0 : Math.round((stdev / mean) * 1_000) / 1_000,
  };
}
