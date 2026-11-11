import { describe, expect, it } from 'vitest';
import { gapStatistics, jitteredDelay, planPublishSlots } from '../src/lib/rateLimit/jitter';

const HOUR = 60 * 60 * 1_000;
const DAY = 24 * HOUR;
const START = Date.parse('2026-11-12T00:00:00.000Z');

function seeded(seed = 42): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

describe('publish slot planner', () => {
  it('places every slot inside the window and in order', () => {
    const slots = planPublishSlots({
      count: 6,
      windowStartMs: START,
      windowEndMs: START + DAY,
      minGapMs: HOUR,
      random: seeded(),
    });
    expect(slots).toHaveLength(6);
    expect(slots.map((slot) => slot.index)).toEqual([0, 1, 2, 3, 4, 5]);
    for (const slot of slots) {
      expect(slot.atMs).toBeGreaterThanOrEqual(START);
      expect(slot.atMs).toBeLessThanOrEqual(START + DAY);
    }
    for (let index = 1; index < slots.length; index += 1) {
      expect(slots[index].atMs).toBeGreaterThan(slots[index - 1].atMs);
    }
  });

  it('respects the minimum gap even with an adversarial random source', () => {
    const slots = planPublishSlots({
      count: 5,
      windowStartMs: START,
      windowEndMs: START + DAY,
      minGapMs: 2 * HOUR,
      random: () => 0,
    });
    for (let index = 1; index < slots.length; index += 1) {
      expect(slots[index].atMs - slots[index - 1].atMs).toBeGreaterThanOrEqual(2 * HOUR);
    }
  });

  it('produces irregular spacing instead of a fixed cadence', () => {
    const slots = planPublishSlots({
      count: 8,
      windowStartMs: START,
      windowEndMs: START + 2 * DAY,
      minGapMs: HOUR,
      random: seeded(7),
    });
    const stats = gapStatistics(slots);
    expect(stats.spreadRatio).toBeGreaterThan(0.01);
    expect(stats.minGapMs).toBeGreaterThanOrEqual(HOUR);
    expect(stats.count).toBe(8);
  });

  it('is deterministic for a given random source', () => {
    const request = {
      count: 4,
      windowStartMs: START,
      windowEndMs: START + DAY,
      minGapMs: 2 * HOUR,
    };
    const first = planPublishSlots({ ...request, random: seeded(99) });
    const second = planPublishSlots({ ...request, random: seeded(99) });
    expect(first.map((slot) => slot.iso)).toEqual(second.map((slot) => slot.iso));
  });

  it('pushes slots off the whole-minute grid schedulers wake on', () => {
    const slots = planPublishSlots({
      count: 3,
      windowStartMs: START,
      windowEndMs: START + 6 * HOUR,
      minGapMs: HOUR,
      guardMs: 15_000,
      random: () => 0,
    });
    for (const slot of slots) {
      expect(slot.atMs % 60_000).toBeGreaterThanOrEqual(15_000);
    }
  });

  it('keeps the first slot past the lead time', () => {
    const slots = planPublishSlots({
      count: 3,
      windowStartMs: START,
      windowEndMs: START + DAY,
      minGapMs: 2 * HOUR,
      leadMs: 4 * HOUR,
      random: seeded(3),
    });
    expect(slots[0].atMs).toBeGreaterThanOrEqual(START + 4 * HOUR);
  });

  it('rejects a window too small for the requested cadence', () => {
    expect(() =>
      planPublishSlots({ count: 6, windowStartMs: START, windowEndMs: START + 3 * HOUR, minGapMs: 2 * HOUR }),
    ).toThrow(/cannot fit/);
  });

  it('rejects a zero or negative count and a backwards window', () => {
    expect(() => planPublishSlots({ count: 0, windowStartMs: START, windowEndMs: START + DAY })).toThrow(/>= 1/);
    expect(() => planPublishSlots({ count: 2, windowStartMs: START + DAY, windowEndMs: START })).toThrow(/end after/);
  });

  it('handles a single slot and reports zero gaps', () => {
    const slots = planPublishSlots({
      count: 1,
      windowStartMs: START,
      windowEndMs: START + HOUR,
      minGapMs: 0,
      random: () => 0.5,
    });
    expect(slots).toHaveLength(1);
    expect(gapStatistics(slots)).toMatchObject({ count: 1, meanGapMs: 0, spreadRatio: 0 });
  });
});

describe('jitter helper', () => {
  it('stays inside the upper part of the base delay', () => {
    expect(jitteredDelay(1_000, 0.5, () => 0)).toBe(500);
    expect(jitteredDelay(1_000, 0.5, () => 1)).toBe(1_000);
    expect(jitteredDelay(1_000, 0, () => 0.9)).toBe(1_000);
  });
});

describe('gap statistics', () => {
  it('summarises an irregular cadence', () => {
    const slots = [0, 1_000, 3_000, 6_000].map((atMs, index) => ({
      index,
      atMs,
      iso: new Date(atMs).toISOString(),
      offsetRatio: 0,
      gapVsPrevMs: index === 0 ? 0 : atMs - [0, 1_000, 3_000, 6_000][index - 1],
    }));
    const stats = gapStatistics(slots);
    expect(stats.meanGapMs).toBe(2_000);
    expect(stats.minGapMs).toBe(1_000);
    expect(stats.maxGapMs).toBe(3_000);
    expect(stats.spreadRatio).toBeGreaterThan(0);
  });
});
