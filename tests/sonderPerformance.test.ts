import { describe, expect, it } from 'vitest';
import { logDraftFromPlan, PERFORMANCE_MIN_SAMPLE, saveRateOf, summarizeLogs, withMultiplier } from '../src/services/sonder/performance';
import type { PerformanceLog } from '../src/services/sonder/types';

const base = {
  planId: null,
  title: '영상',
  postedAt: '2026-11-20',
  medianViews: 10000,
  createdAt: '2026-11-20T00:00:00.000Z',
} as const;

function make(overrides: Partial<PerformanceLog>): PerformanceLog {
  return {
    id: `log_${Math.random().toString(36).slice(2, 8)}`,
    hookPattern: 'question',
    views: 10000,
    saves: 100,
    shares: 10,
    follows: 1,
    multiplier: null,
    ...base,
    ...overrides,
  } as PerformanceLog;
}

describe('성과 로그', () => {
  it('저장률은 조회수 대비 저장 비율이고, 조회수가 0이면 0이다', () => {
    expect(saveRateOf({ views: 10000, saves: 250 })).toBe(0.025);
    expect(saveRateOf({ views: 0, saves: 5 })).toBe(0);
  });

  it('기록할 때 그때의 중간값으로 배수를 계산해 남긴다', () => {
    const log = withMultiplier({
      id: 'log_1',
      planId: null,
      title: '주방 수납',
      hookPattern: 'numbers',
      postedAt: '2026-11-20',
      views: 46000,
      saves: 1200,
      shares: 90,
      follows: 12,
      medianViews: 11500,
      createdAt: '2026-11-20T00:00:00.000Z',
    });
    expect(log.multiplier).toBe(4);
  });

  it('요약은 가중 저장률과 패턴별 순위를 낸다', () => {
    const logs = [
      make({ hookPattern: 'question', views: 10000, saves: 400 }),
      make({ hookPattern: 'question', views: 20000, saves: 600 }),
      make({ hookPattern: 'numbers', views: 10000, saves: 100 }),
      make({ hookPattern: 'contrarian', views: 50000, saves: 250, multiplier: 5 }),
    ];
    const summary = summarizeLogs(logs);
    expect(summary.count).toBe(4);
    expect(summary.views).toBe(90000);
    expect(summary.saves).toBe(1350);
    expect(summary.saveRate).toBeCloseTo(0.015, 4);
    expect(summary.patternRows[0]).toMatchObject({ pattern: 'question', count: 2 });
    expect(summary.bestPattern).toBe('question');
    expect(summary.viralCount).toBe(1);
    expect(summary.avgMultiplier).toBe(5);
    expect(summary.notes.join(' ')).toContain('질문형');
  });

  it(`${PERFORMANCE_MIN_SAMPLE}건이 안 된 패턴은 1등으로 부르지 않는다`, () => {
    const summary = summarizeLogs([make({ hookPattern: 'howto', views: 10000, saves: 900 })]);
    expect(summary.bestPattern).toBeNull();
    expect(summary.notes.join(' ')).toContain('2건 이상');
  });

  it('기록이 없으면 다음에 무엇을 하면 되는지 말한다', () => {
    const summary = summarizeLogs([]);
    expect(summary.count).toBe(0);
    expect(summary.bestPattern).toBeNull();
    expect(summary.notes[0]).toContain('아직 기록이 없습니다');
  });

  it('기획안에서 로그 초안을 만들면 고른 훅 패턴을 가져온다', () => {
    const draft = logDraftFromPlan({
      id: 'plan_1',
      topic: '주방 수납',
      hooks: [
        { id: 'A', pattern: 'numbers' },
        { id: 'B', pattern: 'contrarian' },
      ],
      chosenHook: 'B',
    });
    expect(draft).toEqual({ planId: 'plan_1', title: '주방 수납', hookPattern: 'contrarian' });
  });
});
