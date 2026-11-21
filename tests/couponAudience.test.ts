import { describe, expect, it } from 'vitest';
import { InteractiveCouponDispatcher, type InteractiveCampaign } from '../src/core/interactiveCouponDispatcher';
import { CouponDesk, DEFAULT_RULE, POSTS, campaignFrom } from '../web/model/coupon';

/**
 * 팔로워 전용 필터와 슬로우 큐(발송 간격) — 브라우저 엔진.
 *
 * 서버(PHP)와 같은 규칙을 브라우저에서 돌리는 쪽이라, 두 곳이 같은 답을 내야 한다.
 *  · 팔로워 전용: 팔로워임이 확인된 댓글에만 보낸다. 확인 안 된 작성자는 보내지 않는다.
 *  · 발송 간격: 같은 캠페인의 DM을 간격만큼 띄우고, 데드라인도 그 시각에서 다시 센다.
 */

const NOW = Date.parse('2026-11-21T10:00:00+09:00');

function campaign(overrides: Partial<InteractiveCampaign> = {}): InteractiveCampaign {
  return {
    ...campaignFrom(POSTS[0]!, { ...DEFAULT_RULE, claimLimit: 50 }, NOW),
    ...overrides,
  };
}

function dispatcher(target: InteractiveCampaign, now: () => number): InteractiveCouponDispatcher {
  return new InteractiveCouponDispatcher({ campaigns: [target], signingKey: 'test-key', now });
}

function payload(id: string, author: string, isFollower?: boolean | null): unknown {
  const from: Record<string, unknown> = { id: author, username: `user_${author}` };
  if (isFollower !== undefined) from.is_follower = isFollower;
  return {
    object: 'instagram',
    entry: [
      {
        changes: [
          {
            field: 'comments',
            value: { id, text: '쿠폰 주세요', from, media: { id: POSTS[0]!.id } },
          },
        ],
      },
    ],
  };
}

describe('팔로워 전용 댓글 → DM', () => {
  it('팔로워가 확인된 댓글에만 보낸다', async () => {
    const engine = dispatcher(campaign({ followerOnly: true }), () => NOW);

    const follower = await engine.ingest(payload('c1', 'a1', true));
    const stranger = await engine.ingest(payload('c2', 'a2', false));
    const unknown = await engine.ingest(payload('c3', 'a3', null));

    expect(follower.enqueued).toBe(1);
    expect(stranger.enqueued).toBe(0);
    expect(stranger.nonFollower).toBe(1);
    expect(unknown.enqueued).toBe(0);
    expect(unknown.nonFollower).toBe(1);
    expect(engine.jobsSnapshot()).toHaveLength(1);
  });

  it('팔로워 필터가 꺼져 있으면 확인 안 된 작성자에게도 보낸다', async () => {
    const engine = dispatcher(campaign({ followerOnly: false }), () => NOW);
    const result = await engine.ingest(payload('c4', 'a4', null));
    expect(result.enqueued).toBe(1);
    expect(result.nonFollower).toBe(0);
  });

  it('팔로워가 아니어서 건너뛴 댓글은 장수를 쓰지 않는다', async () => {
    const engine = dispatcher(campaign({ followerOnly: true, claimLimit: 1 }), () => NOW);
    await engine.ingest(payload('c5', 'a5', false));
    const follower = await engine.ingest(payload('c6', 'a6', true));
    expect(follower.enqueued).toBe(1);
  });

  it('운영 콘솔 규칙이 엔진 캠페인으로 그대로 넘어간다', () => {
    const rule = { ...DEFAULT_RULE, followerOnly: true, sendIntervalSeconds: 10 };
    const built = campaignFrom(POSTS[0]!, rule, NOW);
    expect(built.followerOnly).toBe(true);
    expect(built.sendIntervalSeconds).toBe(10);
  });
});

describe('슬로우 큐(발송 간격)', () => {
  it('간격만큼 발송 시각을 밀고 데드라인도 함께 민다', async () => {
    const engine = dispatcher(campaign({ sendIntervalSeconds: 10 }), () => NOW);

    await engine.ingest(payload('c10', 'a10'));
    await engine.ingest(payload('c11', 'a11'));
    await engine.ingest(payload('c12', 'a12'));

    const jobs = engine.jobsSnapshot().sort((a, b) => a.id - b.id);
    expect(jobs.map((job) => job.availableAt - NOW)).toEqual([0, 10_000, 20_000]);
    // 데드라인 = 발송 가능 시각 + 5초
    expect(jobs.map((job) => job.deadline - job.availableAt)).toEqual([5_000, 5_000, 5_000]);
  });

  it('간격이 지나기 전에는 한 건만 나가고, 늦은 건으로 세지 않는다', async () => {
    let now = NOW;
    const sent: number[] = [];
    const engine = new InteractiveCouponDispatcher({
      campaigns: [campaign({ sendIntervalSeconds: 10 })],
      signingKey: 'test-key',
      now: () => now,
      send: (job) => {
        sent.push(job.id);
        return { ok: true };
      },
    });

    await engine.ingest(payload('c20', 'a20'));
    await engine.ingest(payload('c21', 'a21'));

    const first = await engine.dispatchDue(10);
    expect(first.dispatched).toBe(1);
    expect(first.late).toBe(0);

    await engine.dispatchDue(10);
    expect(sent).toHaveLength(1);

    now += 10_000;
    const second = await engine.dispatchDue(10);
    expect(second.dispatched).toBe(1);
    expect(sent).toHaveLength(2);
  });

  it('간격이 0이면 바로 보낸다', async () => {
    const engine = dispatcher(campaign({ sendIntervalSeconds: 0 }), () => NOW);
    await engine.ingest(payload('c30', 'a30'));
    await engine.ingest(payload('c31', 'a31'));
    const jobs = engine.jobsSnapshot();
    expect(jobs.every((job) => job.availableAt === NOW)).toBe(true);
  });

  it('콘솔 데스크가 팔로워 아님 댓글을 지나감으로 표시한다', async () => {
    const desk = new CouponDesk(() => NOW);
    desk.applyRule(POSTS[0]!, { ...DEFAULT_RULE, followerOnly: true });

    await desk.submitComment({ text: '쿠폰 주세요', handle: 'not_follower', isFollower: false });
    await desk.submitComment({ text: '쿠폰 주세요', handle: 'is_follower', isFollower: true });

    expect(desk.ingest.nonFollower).toBe(1);
    expect(desk.ingest.enqueued).toBe(1);
    const ignored = desk.feed.find((item) => item.kind === 'ignored');
    expect(ignored?.detail).toContain('팔로워');
  });
});
