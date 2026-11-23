/**
 * 성과 로그 — 올린 영상의 숫자를 다음 기획안의 입력으로 되돌린다.
 *
 * 저장률(저장 ÷ 조회수)을 먼저 보는 이유는 조회수가 계정 크기에 끌려가기
 * 때문이다. 배수는 그때의 평소 중간값으로 다시 계산해, 계정이 커진 뒤에도 옛
 * 로그와 같은 자로 비교한다.
 */
import { HOOK_PATTERN_LABEL, type HookPattern, type PatternRow, type PerformanceLog, type PerformanceSummary } from './types';
import { multiplierOf, VIRAL_THRESHOLD } from './viral';

export const PERFORMANCE_MIN_SAMPLE = 2;

export function saveRateOf(log: Pick<PerformanceLog, 'views' | 'saves'>): number {
  if (!Number.isFinite(log.views) || log.views <= 0) return 0;
  return Math.max(0, log.saves) / log.views;
}

/** 로그를 넣을 때 배수를 함께 계산해 둔다. 나중에 중간값이 바뀌어도 기록은 남는다. */
export function withMultiplier(log: Omit<PerformanceLog, 'multiplier'>): PerformanceLog {
  return { ...log, multiplier: multiplierOf(log.views, log.medianViews) };
}

export function summarizeLogs(logs: PerformanceLog[]): PerformanceSummary {
  const count = logs.length;
  const views = logs.reduce((sum, log) => sum + Math.max(0, log.views), 0);
  const saves = logs.reduce((sum, log) => sum + Math.max(0, log.saves), 0);
  const shares = logs.reduce((sum, log) => sum + Math.max(0, log.shares), 0);
  const saveRate = views > 0 ? saves / views : 0;

  const withMultiplier = logs.filter((log) => typeof log.multiplier === 'number' && log.multiplier !== null);
  const avgMultiplier =
    withMultiplier.length > 0
      ? Math.round((withMultiplier.reduce((sum, log) => sum + (log.multiplier as number), 0) / withMultiplier.length) * 100) /
        100
      : null;

  const grouped = new Map<HookPattern, PerformanceLog[]>();
  for (const log of logs) {
    const list = grouped.get(log.hookPattern) ?? [];
    list.push(log);
    grouped.set(log.hookPattern, list);
  }

  const patternRows: PatternRow[] = [...grouped.entries()]
    .map(([pattern, items]) => {
      const patternViews = items.reduce((sum, item) => sum + Math.max(0, item.views), 0);
      const patternSaves = items.reduce((sum, item) => sum + Math.max(0, item.saves), 0);
      const multipliers = items
        .map((item) => item.multiplier)
        .filter((value): value is number => typeof value === 'number' && value !== null);
      return {
        pattern,
        count: items.length,
        saveRate: patternViews > 0 ? patternSaves / patternViews : 0,
        avgMultiplier:
          multipliers.length > 0
            ? Math.round((multipliers.reduce((sum, value) => sum + value, 0) / multipliers.length) * 100) / 100
            : null,
      };
    })
    .sort((a, b) => b.saveRate - a.saveRate || b.count - a.count);

  const best = patternRows.find((row) => row.count >= PERFORMANCE_MIN_SAMPLE) ?? null;
  const notes: string[] = [];

  if (count === 0) {
    notes.push('아직 기록이 없습니다. 한 편을 올린 뒤 숫자를 넣으면 다음 기획안이 그 값을 참고합니다.');
  } else {
    if (best) {
      notes.push(
        `${HOOK_PATTERN_LABEL[best.pattern]} 훅이 ${best.count}건 평균 저장률 ${(best.saveRate * 100).toFixed(1)}%로 가장 높습니다. 다음 기획안에서 이 안을 먼저 추천합니다.`,
      );
    } else {
      notes.push(`같은 훅이 ${PERFORMANCE_MIN_SAMPLE}건 이상 쌓여야 우열을 말할 수 있습니다. 지금은 기록만 쌓으세요.`);
    }
    if (avgMultiplier !== null) {
      notes.push(`평균 배수 ${avgMultiplier.toFixed(2)}배, ${VIRAL_THRESHOLD}배 이상은 ${logs.filter((log) => (log.multiplier ?? 0) >= VIRAL_THRESHOLD).length}건입니다.`);
    }
    if (views > 0 && saveRate < 0.01) {
      notes.push(`저장률이 ${(saveRate * 100).toFixed(2)}%로 낮습니다. 저장을 부르는 마무리 문장을 바꿔 보세요.`);
    }
  }

  return {
    count,
    views,
    saves,
    shares,
    saveRate: Math.round(saveRate * 10000) / 10000,
    avgMultiplier,
    viralCount: logs.filter((log) => (log.multiplier ?? 0) >= VIRAL_THRESHOLD).length,
    bestPattern: best?.pattern ?? null,
    patternRows,
    notes,
  };
}

/** 기획안에서 로그 초안을 만든다. 화면에서 숫자만 채우면 되게. */
export function logDraftFromPlan(plan: {
  id: string;
  topic: string;
  hooks: Array<{ id: string; pattern: HookPattern }>;
  chosenHook: string;
}): { planId: string; title: string; hookPattern: HookPattern } {
  const hook = plan.hooks.find((item) => item.id === plan.chosenHook) ?? plan.hooks[0];
  return {
    planId: plan.id,
    title: plan.topic,
    hookPattern: hook?.pattern ?? 'story',
  };
}
