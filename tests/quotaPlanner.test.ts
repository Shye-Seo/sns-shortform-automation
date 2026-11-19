import { describe, expect, it } from 'vitest';
import {
  nextSlotAtOrAfter,
  planFromLimitDecision,
  planFromTenantView,
  planPublishQuota,
  summarizePlan,
  type PublishJobRequest,
  type QuotaPlannerInput,
  type SlotPolicy,
} from '../src/lib/rateLimit/quotaPlanner';
import type { LimitDecision, TenantLimitView } from '../src/lib/rateLimit/tenantRegistry';
import { ShortformError } from '../src/lib/errors';

/**
 * 쿼터 인지 발행 스케줄러 테스트.
 *
 * 검증 대상은 "플랫폼 한도 안에서 실제로 나갈 시각을 계산하는가"다. 시계와 예산을 인자로 주므로
 * 날짜에 의존하지 않는다. 모든 시각은 UTC 기준이다.
 */

const DAY = 24 * 60 * 60 * 1000;
const MINUTE = 60 * 1000;
const NOW = Date.parse('2026-11-19T00:00:00.000Z');

const YOUTUBE = { limitUnits: 10_000, unitCost: 1_600 };

function baseInput(overrides: Partial<QuotaPlannerInput> = {}): QuotaPlannerInput {
  return {
    provider: 'youtube',
    nowMs: NOW,
    budget: { ...YOUTUBE, windowStartMs: NOW },
    jobs: [],
    ...overrides,
  };
}

function jobs(count: number, prefix = 'job'): PublishJobRequest[] {
  return Array.from({ length: count }, (_, index) => ({ id: `${prefix}-${index + 1}` }));
}

function hourOf(ts: number): number {
  return Math.floor((ts % DAY) / (60 * MINUTE));
}

describe('유튜브 예산(1편 1,600 · 하루 10,000)', () => {
  it('6편까지 첫 창에 배치되고 7편째부터 다음 창으로 밀린다', () => {
    const plan = planPublishQuota(baseInput({ jobs: jobs(8) }));

    expect(plan.assignments).toHaveLength(8);
    expect(plan.deferred).toHaveLength(0);
    expect(plan.windows[0]?.jobs).toBe(6);
    expect(plan.windows[0]?.plannedUnits).toBe(9_600);
    expect(plan.windows[1]?.jobs).toBe(2);

    const inFirst = plan.assignments.filter((entry) => entry.windowIndex === 0);
    const inSecond = plan.assignments.filter((entry) => entry.windowIndex === 1);
    expect(inFirst.map((entry) => entry.reason)).toEqual(Array(6).fill('preferred'));
    expect(inSecond.every((entry) => entry.reason === 'quota-shifted')).toBe(true);
    // 밀린 작업은 정확히 다음 창 시작(리셋 시각)에 놓인다
    expect(inSecond.every((entry) => entry.publishAtMs >= NOW + DAY)).toBe(true);
  });

  it('첫 창에 이미 8,400을 썼다면 남은 1,600으로 한 편만 나간다', () => {
    const plan = planPublishQuota(
      baseInput({ budget: { ...YOUTUBE, windowStartMs: NOW, usedUnits: 8_400 }, jobs: jobs(3) }),
    );
    expect(plan.windows[0]?.capacityUnits).toBe(1_600);
    expect(plan.assignments.filter((entry) => entry.windowIndex === 0)).toHaveLength(1);
    expect(plan.assignments.filter((entry) => entry.windowIndex === 1)).toHaveLength(2);
  });

  it('예산이 0이면 전부 다음 창으로 미루고, 그 시각을 알려 준다', () => {
    const plan = planPublishQuota(
      baseInput({ budget: { ...YOUTUBE, windowStartMs: NOW, usedUnits: 10_000 }, jobs: jobs(2) }),
    );
    expect(plan.windows[0]?.capacityUnits).toBe(0);
    expect(plan.assignments.every((entry) => entry.windowIndex === 1)).toBe(true);
  });
});

describe('메타 예산(하루 25편)', () => {
  it('30편이면 25편 + 5편으로 창이 갈린다', () => {
    const plan = planPublishQuota({
      provider: 'meta',
      nowMs: NOW,
      budget: { limitUnits: 25, unitCost: 1, windowStartMs: NOW },
      jobs: jobs(30),
    });
    expect(plan.windows[0]?.jobs).toBe(25);
    expect(plan.windows[1]?.jobs).toBe(5);
    expect(plan.deferred).toHaveLength(0);
  });

  it('계획 지평(창 수)을 넘으면 미배치로 남기고 사유를 붙인다', () => {
    const plan = planPublishQuota({
      provider: 'meta',
      nowMs: NOW,
      budget: { limitUnits: 2, unitCost: 1, windowStartMs: NOW },
      jobs: jobs(7),
      maxWindows: 3,
    });
    expect(plan.assignments).toHaveLength(6);
    expect(plan.deferred).toEqual([{ jobId: 'job-7', reason: 'quota-exhausted', earliestAtMs: null }]);
  });
});

describe('순서와 우선순위', () => {
  it('우선순위가 높은 작업이 희망 시각을 지킨다', () => {
    const plan = planPublishQuota({
      provider: 'meta',
      nowMs: NOW,
      budget: { limitUnits: 1, unitCost: 1, windowStartMs: NOW },
      jobs: [
        { id: 'promo', preferredAtMs: NOW, priority: 0 },
        { id: 'paid', preferredAtMs: NOW, priority: 9 },
      ],
    });
    const paid = plan.assignments.find((entry) => entry.jobId === 'paid');
    const promo = plan.assignments.find((entry) => entry.jobId === 'promo');
    expect(paid?.windowIndex).toBe(0);
    expect(promo?.windowIndex).toBe(1);
  });

  it('우선순위가 같으면 희망 시각이 이른 작업부터, 그것도 같으면 id 순으로 배치한다', () => {
    const plan = planPublishQuota({
      provider: 'meta',
      nowMs: NOW,
      budget: { limitUnits: 1, unitCost: 1, windowStartMs: NOW },
      jobs: [
        { id: 'b', preferredAtMs: NOW + 1_000 },
        { id: 'a', preferredAtMs: NOW + 1_000 },
        { id: 'c', preferredAtMs: NOW + 500 },
      ],
    });
    expect(plan.assignments.map((entry) => entry.jobId)).toEqual(['c', 'a', 'b']);
    expect(plan.assignments.map((entry) => entry.windowIndex)).toEqual([0, 1, 2]);
  });

  it('입력 순서가 달라도 결과가 같다(결정적)', () => {
    const a = planPublishQuota(baseInput({ jobs: jobs(10).reverse() }));
    const b = planPublishQuota(baseInput({ jobs: jobs(10) }));
    expect(JSON.stringify(a.assignments)).toBe(JSON.stringify(b.assignments));
  });
});

describe('발행 슬롯', () => {
  const daytime: SlotPolicy = { startMinute: 8 * 60, endMinute: 23 * 60 };

  it('슬롯 밖 시각은 같은 날 슬롯 시작으로 밀린다', () => {
    const plan = planPublishQuota({
      provider: 'meta',
      nowMs: Date.parse('2026-11-19T02:00:00.000Z'),
      budget: { limitUnits: 5, unitCost: 1, windowStartMs: Date.parse('2026-11-19T00:00:00.000Z') },
      jobs: [{ id: 'job-1' }],
      slot: daytime,
    });
    const assignment = plan.assignments[0];
    expect(assignment?.reason).toBe('slot-shifted');
    expect(hourOf(assignment!.publishAtMs)).toBe(8);
    expect(assignment?.delayMs).toBe(6 * 60 * MINUTE);
  });

  it('슬롯이 끝난 뒤면 다음 날 슬롯 시작으로 넘어간다', () => {
    const plan = planPublishQuota({
      provider: 'meta',
      nowMs: Date.parse('2026-11-19T23:30:00.000Z'),
      budget: { limitUnits: 5, unitCost: 1, windowStartMs: Date.parse('2026-11-19T00:00:00.000Z') },
      jobs: [{ id: 'job-1' }],
      slot: daytime,
      maxWindows: 3,
    });
    const assignment = plan.assignments[0];
    expect(assignment?.publishAtMs).toBe(Date.parse('2026-11-20T08:00:00.000Z'));
  });

  it('자정을 넘는 슬롯(22시–06시)도 계산한다', () => {
    const night: SlotPolicy = { startMinute: 22 * 60, endMinute: 6 * 60, minGapMs: 5 * 60 * MINUTE };
    const plan = planPublishQuota({
      provider: 'meta',
      nowMs: Date.parse('2026-11-19T12:00:00.000Z'),
      budget: { limitUnits: 5, unitCost: 1, windowStartMs: Date.parse('2026-11-19T12:00:00.000Z') },
      jobs: [{ id: 'job-1' }, { id: 'job-2' }],
      slot: night,
    });
    expect(plan.assignments.map((entry) => hourOf(entry.publishAtMs))).toEqual([22, 3]);
  });

  it('슬롯 안 시각은 건드리지 않는다', () => {
    const plan = planPublishQuota({
      provider: 'meta',
      nowMs: Date.parse('2026-11-19T10:15:00.000Z'),
      budget: { limitUnits: 5, unitCost: 1, windowStartMs: Date.parse('2026-11-19T00:00:00.000Z') },
      jobs: [{ id: 'job-1' }],
      slot: daytime,
    });
    expect(plan.assignments[0]?.reason).toBe('preferred');
    expect(plan.assignments[0]?.publishAtMs).toBe(Date.parse('2026-11-19T10:15:00.000Z'));
  });

  it('nextSlotAtOrAfter는 슬롯 안/밖을 같은 규칙으로 판단한다', () => {
    const slot = { start: 540, end: 1080, minGapMs: 0, offsetMs: 0, enabled: true };
    expect(nextSlotAtOrAfter(Date.parse('2026-11-19T09:00:00.000Z'), slot)).toBe(
      Date.parse('2026-11-19T09:00:00.000Z'),
    );
    expect(nextSlotAtOrAfter(Date.parse('2026-11-19T03:00:00.000Z'), slot)).toBe(
      Date.parse('2026-11-19T09:00:00.000Z'),
    );
    expect(nextSlotAtOrAfter(Date.parse('2026-11-19T20:00:00.000Z'), slot)).toBe(
      Date.parse('2026-11-20T09:00:00.000Z'),
    );
  });
});

describe('최소 간격과 승인 대기', () => {
  it('같은 시각을 원한 작업들을 최소 간격만큼 벌린다', () => {
    const plan = planPublishQuota({
      provider: 'meta',
      nowMs: NOW,
      budget: { limitUnits: 10, unitCost: 1, windowStartMs: NOW },
      jobs: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      slot: { minGapMs: 30 * MINUTE },
    });
    expect(plan.assignments.map((entry) => entry.publishAtMs)).toEqual([
      NOW,
      NOW + 30 * MINUTE,
      NOW + 60 * MINUTE,
    ]);
    expect(plan.assignments.map((entry) => entry.reason)).toEqual(['preferred', 'gap-shifted', 'gap-shifted']);
  });

  it('notBefore 이전에는 나가지 않는다', () => {
    const plan = planPublishQuota({
      provider: 'meta',
      nowMs: NOW,
      budget: { limitUnits: 5, unitCost: 1, windowStartMs: NOW },
      jobs: [{ id: 'approval', preferredAtMs: NOW, notBeforeMs: NOW + 2 * 60 * MINUTE }],
    });
    expect(plan.assignments[0]?.publishAtMs).toBe(NOW + 2 * 60 * MINUTE);
    expect(plan.assignments[0]?.delayMs).toBe(2 * 60 * MINUTE);
  });

  it('희망 시각이 과거면 지금으로 당긴다', () => {
    const plan = planPublishQuota({
      provider: 'meta',
      nowMs: NOW,
      budget: { limitUnits: 5, unitCost: 1, windowStartMs: NOW },
      jobs: [{ id: 'late', preferredAtMs: NOW - DAY }],
    });
    expect(plan.assignments[0]?.publishAtMs).toBe(NOW);
    expect(plan.assignments[0]?.delayMs).toBe(0);
  });
});

describe('입력 검증', () => {
  it('잘못된 예산·작업은 조용히 넘어가지 않고 오류를 낸다', () => {
    expect(() => planPublishQuota(baseInput({ budget: { limitUnits: 10, unitCost: 0 } }))).toThrow(ShortformError);
    expect(() => planPublishQuota(baseInput({ budget: { limitUnits: -1, unitCost: 1 } }))).toThrow(ShortformError);
    expect(() =>
      planPublishQuota(baseInput({ budget: { limitUnits: 10, unitCost: 1, windowMs: 0 } })),
    ).toThrow(ShortformError);
    expect(() => planPublishQuota(baseInput({ jobs: [{ id: '' }] }))).toThrow(ShortformError);
    expect(() => planPublishQuota(baseInput({ jobs: [{ id: 'x' }, { id: 'x' }] }))).toThrow(ShortformError);
    expect(() =>
      planPublishQuota(baseInput({ slot: { startMinute: 600, endMinute: 600 } })),
    ).toThrow(ShortformError);
  });

  it('작업이 없으면 빈 계획을 돌려준다', () => {
    const plan = planPublishQuota(baseInput());
    expect(plan.assignments).toEqual([]);
    expect(plan.deferred).toEqual([]);
    expect(plan.windows).toHaveLength(14);
  });
});

describe('제한 결정·테넌트 스냅숏 연동', () => {
  it('LimitDecision의 남은 예산과 리셋 시각으로 계획을 세운다', () => {
    const decision: LimitDecision = {
      tenantId: 'agency-a',
      provider: 'youtube',
      allowed: false,
      reason: 'quota-exhausted',
      requestRemaining: 12,
      requestCapacity: 20,
      quotaRemaining: 2_000,
      quotaLimit: 10_000,
      quotaResetInMs: 3 * 60 * MINUTE,
      retryAfterMs: 3 * 60 * MINUTE,
    };
    const plan = planFromLimitDecision(decision, jobs(3), { nowMs: NOW, unitCost: 1_600 });

    // 첫 창에는 2,000 unit이 남아 1편, 나머지는 리셋(3시간 뒤)부터
    expect(plan.windows[0]?.capacityUnits).toBe(2_000);
    expect(plan.assignments.filter((entry) => entry.windowIndex === 0)).toHaveLength(1);
    expect(plan.windows[1]?.startMs).toBe(NOW + 3 * 60 * MINUTE);
  });

  it('테넌트 스냅숏에서 바로 계획을 세운다', () => {
    const view: TenantLimitView = {
      tenantId: 'agency-a',
      name: '대행사 A',
      plan: 'agency',
      providers: [
        {
          provider: 'meta',
          label: 'Meta Graph API',
          requestRemaining: 30,
          requestCapacity: 75,
          utilization: 0.1,
          quotaRemaining: 3,
          quotaLimit: 25,
          quotaResetInMs: 10 * 60 * MINUTE,
          blockedForMs: 0,
        },
      ],
    };
    const plan = planFromTenantView(view, 'meta', jobs(5), { nowMs: NOW });
    expect(plan.assignments.filter((entry) => entry.windowIndex === 0)).toHaveLength(3);
    expect(plan.assignments.filter((entry) => entry.windowIndex === 1)).toHaveLength(2);
    expect(() => planFromTenantView(view, 'youtube', jobs(1), { nowMs: NOW })).toThrow(ShortformError);
  });
});

describe('계획 요약', () => {
  it('배치·미배치 건수, 사용 단위, 창별 소진율을 낸다', () => {
    const plan = planPublishQuota(baseInput({ jobs: jobs(8) }));
    const summary = summarizePlan(plan);
    expect(summary.planned).toBe(8);
    expect(summary.deferred).toBe(0);
    expect(summary.totalUnits).toBe(12_800);
    expect(summary.usedWindows).toBe(2);
    expect(summary.utilization[0]).toBe(0.96);
    expect(summary.utilization[1]).toBe(0.32);
    expect(summary.spanMs).toBe(DAY);
  });

  it('작업이 없으면 요약도 0이다', () => {
    const summary = summarizePlan(planPublishQuota(baseInput()));
    expect(summary).toMatchObject({ planned: 0, deferred: 0, totalUnits: 0, usedWindows: 0, spanMs: 0 });
  });
});
