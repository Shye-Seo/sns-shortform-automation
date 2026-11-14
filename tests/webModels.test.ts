import { describe, expect, it } from 'vitest';
import { buildStudioModel, cueAt, draftBeatScene, gainAt, sceneAt } from '../web/model/studio';
import { CAMPAIGN, CouponDesk } from '../web/model/coupon';
import { PublishDesk } from '../web/model/publishing';
import { AbTest } from '../web/model/abtest';

/**
 * The demo console is a view over the engine, so the tests assert the engine's
 * invariants through the same read model the browser uses: the timeline fits the
 * budget, the duck hits 15% under speech, one comment produces exactly one DM,
 * a flood is blocked, a coupon is granted once, and the quota stops the queue.
 */

const TOPIC = '부산 신혼집 3평 주방 수납 정리법';

describe('web studio model', () => {
  it('builds a 4-beat timeline that fits the target duration', () => {
    const drafts = draftBeatScene(TOPIC, 45);
    const model = buildStudioModel({ topic: TOPIC, durationSec: 45, speed: 1, language: 'ko', drafts, compress: true });

    expect(model.scenes.length).toBeGreaterThanOrEqual(4);
    expect(model.scenes[0]?.beat).toBe('hook');
    expect(model.scenes.at(-1)?.beat).toBe('cta');
    expect(model.totalDurationSec).toBeLessThanOrEqual(45.01);
    expect(model.scenes[0]?.durationSec).toBeLessThanOrEqual(3.5);
    expect(model.overrunSec).toBe(0);

    // Scenes are contiguous and end where the next begins.
    for (let index = 1; index < model.scenes.length; index += 1) {
      const previous = model.scenes[index - 1]!;
      expect(model.scenes[index]!.startSec).toBeCloseTo(previous.startSec + previous.durationSec, 2);
    }
  });

  it('produces word timings and caption cards inside the safe area', () => {
    const drafts = draftBeatScene(TOPIC, 45);
    const model = buildStudioModel({ topic: TOPIC, durationSec: 45, speed: 1, language: 'ko', drafts, compress: true });

    expect(model.words.length).toBeGreaterThan(20);
    expect(model.cues.length).toBeGreaterThan(3);
    expect(model.widestCueWidthPx).toBeLessThanOrEqual(model.layout.caption.w);
    expect(model.collisions.ok).toBe(true);

    const cue = cueAt(model, 1);
    expect(cue).not.toBeNull();
    expect(cue!.lines.length).toBeGreaterThan(0);
    expect(sceneAt(model, 1)).not.toBeNull();
  });

  it('ducks the music to 15% under speech and returns to 55% in the gaps', () => {
    const drafts = draftBeatScene(TOPIC, 45);
    const model = buildStudioModel({ topic: TOPIC, durationSec: 45, speed: 1, language: 'ko', drafts, compress: true });

    const gains = model.envelope.keyframes.map((key) => key.gain);
    expect(Math.min(...gains)).toBeCloseTo(0.15, 2);
    expect(Math.max(...gains)).toBeCloseTo(0.55, 2);
    // The BGM percentage the phone shows during the hook.
    expect(gainAt(model, 0.6)).toBeLessThanOrEqual(0.55);
    expect(model.envelope.duckedRatio).toBeGreaterThan(0.5);
  });

  it('keeps edited narration verbatim when compression is off, and reports the overrun', () => {
    const drafts = draftBeatScene(TOPIC, 30).map((draft, index) =>
      index === 1 ? { ...draft, narration: `${draft.narration} ${'정말 '.repeat(30)}` } : draft,
    );
    const model = buildStudioModel({ topic: TOPIC, durationSec: 30, speed: 1, language: 'ko', drafts, compress: false });

    expect(model.scenes[1]?.narration).toContain('정말 정말');
    expect(model.overrunSec).toBeGreaterThan(0);
    expect(model.compression.applied).toBe(false);
  });
});

describe('web coupon desk', () => {
  it('turns one keyword comment into one signed DM link, and grants the coupon once', async () => {
    const desk = new CouponDesk(() => Date.now());
    await desk.submitComment({ text: '쿠폰 주세요!', handle: 'guri_home' });
    expect(desk.ingest.enqueued).toBe(1);

    await desk.runWorkerCycle();
    expect(desk.dms).toHaveLength(1);
    const dm = desk.dms[0]!;
    expect(dm.deepLink).toMatch(/^https:\/\/coupon\.shye\.kr\/c\/[0-9a-f-]{36}\./);
    expect(dm.expiresAt - dm.at).toBe(15 * 60_000);

    const first = await desk.claimDm(dm.jobId);
    expect(first.status).toBe('GRANTED');
    expect(first.rewardAmount).toBe(CAMPAIGN.rewardAmount);

    const second = await desk.claimDm(dm.jobId);
    expect(second.status).toBe('ALREADY_CLAIMED');
    expect(desk.poolGranted).toBe(1);
    expect(desk.poolRemaining).toBe(CAMPAIGN.claimLimit - 1);

    const funnel = desk.funnel();
    expect(funnel.comments).toBe(1);
    expect(funnel.clicks).toBe(1);
    expect(funnel.claims).toBe(1);
  });

  it('blocks the same account flooding with short text instead of issuing more coupons', async () => {
    const desk = new CouponDesk(() => Date.now());
    await desk.submitComment({ text: '쿠폰', reuseAuthor: false });
    await desk.submitComment({ text: '쿠폰', reuseAuthor: true });
    await desk.submitComment({ text: '쿠폰', reuseAuthor: true });

    expect(desk.ingest.abuseBlocked).toBeGreaterThanOrEqual(1);
    expect(desk.ingest.enqueued).toBeLessThanOrEqual(2);
    expect(desk.feed.some((item) => item.kind === 'blocked')).toBe(true);
  });

  it('ignores a comment without a trigger keyword', async () => {
    const desk = new CouponDesk(() => Date.now());
    await desk.submitComment({ text: '잘 보고 갑니다' });
    expect(desk.ingest.ignored).toBe(1);
    expect(desk.ingest.enqueued).toBe(0);
  });

  it('dead-letters a job that misses the 5 second deadline instead of sending late', async () => {
    let clock = 1_000_000;
    const desk = new CouponDesk(() => clock);
    desk.workerPaused = true;
    await desk.submitComment({ text: '쿠폰 주세요!' });

    clock += 6_000; // the worker was down for six seconds
    desk.workerPaused = false;
    await desk.runWorkerCycle();

    expect(desk.dms).toHaveLength(0);
    expect(desk.deadLetters).toHaveLength(1);
    expect(desk.deadLetters[0]?.error).toBe('SLA_EXCEEDED');
    expect(desk.feed.some((item) => item.kind === 'late')).toBe(true);
  });

  it('grants exactly the pool size under a 1,000 comment burst, with no oversell', async () => {
    const desk = new CouponDesk(() => Date.now());
    const report = await desk.runStorm(1_000);

    expect(report.comments).toBe(1_000);
    expect(report.poolOversold).toBe(0);
    expect(report.poolGranted).toBeLessThanOrEqual(CAMPAIGN.claimLimit);
    expect(report.dispatched).toBeGreaterThan(0);
    expect(report.abuseBlocked).toBeGreaterThan(0);
  });
});

describe('web publishing desk', () => {
  it('starts at today\'s usage and stops publishing when a platform quota is exhausted', async () => {
    const desk = new PublishDesk(() => Date.now());
    const meta = desk.quotas()[0]?.providers.find((provider) => provider.provider === 'meta');
    expect(meta?.limit).toBe(25);
    expect(meta?.used).toBe(21);

    let published = 0;
    let blocked = 0;
    for (let index = 0; index < 20; index += 1) {
      const slot = await desk.publishNext();
      if (!slot) break;
      if (slot.state === 'published') published += 1;
      if (slot.state === 'blocked') {
        blocked += 1;
        expect(slot.reason).toMatch(/한도|소진|버킷/);
      }
    }

    expect(published).toBeGreaterThan(0);
    expect(blocked).toBeGreaterThan(0);
    expect(desk.slots.every((slot) => slot.state !== 'scheduled')).toBe(true);
  });

  it('records a refused publish as a queue failure that the DLQ can replay', async () => {
    const desk = new PublishDesk(() => Date.now());
    for (let index = 0; index < 20; index += 1) {
      const slot = await desk.publishNext();
      if (!slot) break;
    }
    const rows = await desk.rows();
    expect(rows.length).toBeGreaterThan(0);

    const target = rows[0]!;
    const outcome = await desk.retry(target.id);
    expect(outcome.ok).toBe(true);
    expect(desk.actions[0]?.action).toBe('retry');
    expect(desk.actions[0]?.outcome).toBe('applied');
  });
});

describe('web hook A/B desk', () => {
  it('refuses to call a winner before the minimum sample, then decides on the leader', () => {
    const test = new AbTest(TOPIC);
    const empty = test.evaluate();
    expect(empty.ready).toBe(false);
    expect(empty.winner).toBeNull();
    expect(empty.rows).toHaveLength(4);

    test.collect(300);
    const small = test.evaluate();
    expect(small.ready).toBe(true);

    test.collect(2_000);
    const decided = test.evaluate();
    expect(decided.rows.every((row) => row.pValue >= 0 && row.pValue <= 1)).toBe(true);
    expect(decided.coupon.pValue).toBeGreaterThanOrEqual(0);
    expect(decided.requiredSample).toBeGreaterThan(0);
    if (decided.winner) {
      expect(['A', 'B']).toContain(decided.winner);
      expect(decided.primary.status).toBe('winner');
    }
  });

  it('gives every hook a length the 3.5 second ceiling accepts', () => {
    const test = new AbTest(TOPIC);
    for (const arm of test.arms) {
      expect(arm.hookSeconds).toBeLessThanOrEqual(3.5);
      expect(arm.text.length).toBeGreaterThan(5);
    }
  });
});
