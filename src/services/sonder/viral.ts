/**
 * 배수 계산 — "이 영상이 그 계정 평소보다 몇 배 터졌나".
 *
 * 조회수만 보면 팔로워가 큰 계정이 늘 이깁니다. 같은 계정의 평소 조회수
 * 중간값으로 나누면 계정 크기를 지운 비교가 남습니다. 중간값을 쓰는 이유는
 * 평균이 이미 터진 영상 하나에 끌려가기 때문입니다.
 */
import { HOOK_PATTERN_LABEL, type HookPattern, type TrendItem, type ViralLevel, type ViralVerdict } from './types';

/** 3배 이상이면 구조를 빌려올 신호로 본다. 이 기준은 화면에도 그대로 적는다. */
export const VIRAL_THRESHOLD = 3;

export function medianOf(values: number[]): number {
  const clean = values.filter((value) => Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
  if (clean.length === 0) return 0;
  const mid = Math.floor(clean.length / 2);
  if (clean.length % 2 === 1) return clean[mid] as number;
  return ((clean[mid - 1] as number) + (clean[mid] as number)) / 2;
}

export function multiplierOf(views: number, medianViews: number): number | null {
  if (!Number.isFinite(views) || !Number.isFinite(medianViews)) return null;
  if (views <= 0 || medianViews <= 0) return null;
  return Math.round((views / medianViews) * 100) / 100;
}

const LEVEL_LABEL: Record<ViralLevel, string> = {
  viral: '바이럴 신호',
  above: '평소보다 높음',
  near: '평소와 비슷',
  below: '평소보다 낮음',
  unknown: '계산 전',
};

export function levelOf(multiplier: number | null): ViralLevel {
  if (multiplier === null) return 'unknown';
  if (multiplier >= VIRAL_THRESHOLD) return 'viral';
  if (multiplier >= 1.8) return 'above';
  if (multiplier >= 0.85) return 'near';
  return 'below';
}

export function viralVerdict(views: number, medianViews: number): ViralVerdict {
  const multiplier = multiplierOf(views, medianViews);
  const level = levelOf(multiplier);
  const label = LEVEL_LABEL[level];
  const medianText = Math.round(medianViews).toLocaleString('ko-KR');

  let note: string;
  if (multiplier === null) {
    note =
      medianViews <= 0
        ? '평소 조회수 중간값이 0이라 배수를 계산할 수 없습니다. 값이 있는 영상을 몇 개 넣어 주세요.'
        : '이 영상 조회수를 넣으면 배수를 계산합니다.';
  } else if (level === 'viral') {
    note = `평소 중간값 ${medianText}회의 ${multiplier.toFixed(1)}배입니다. 3배 이상이라 구조를 빌려올 만한 신호로 봅니다.`;
  } else if (level === 'above') {
    note = `평소 중간값 ${medianText}회의 ${multiplier.toFixed(1)}배입니다. 3배에는 못 미치니 구조는 참고만 합니다.`;
  } else if (level === 'near') {
    note = `평소 중간값 ${medianText}회의 ${multiplier.toFixed(1)}배로 평소 범위입니다. 소재만 참고하세요.`;
  } else {
    note = `평소 중간값 ${medianText}회보다 낮습니다. 구조를 빌려오기 전에 이 영상이 왜 아쉬웠는지부터 보세요.`;
  }

  return { views, medianViews, multiplier, level, label, note };
}

export interface VaultSummary {
  count: number;
  viralCount: number;
  avgMultiplier: number | null;
  topPattern: HookPattern | null;
  patternCounts: Array<{ pattern: HookPattern; count: number }>;
}

/** 보관함 상단에 놓는 요약. 바이럴만 따로 세는 이유는 빌려올 후보가 그것뿐이기 때문이다. */
export function summarizeVault(items: TrendItem[]): VaultSummary {
  const withMultiplier = items.filter((item) => typeof item.multiplier === 'number' && item.multiplier !== null);
  const avgMultiplier =
    withMultiplier.length > 0
      ? Math.round(
          (withMultiplier.reduce((sum, item) => sum + (item.multiplier as number), 0) / withMultiplier.length) * 100,
        ) / 100
      : null;

  const counts = new Map<HookPattern, number>();
  for (const item of items) {
    const pattern = item.structure.hookPattern;
    counts.set(pattern, (counts.get(pattern) ?? 0) + 1);
  }
  const patternCounts = [...counts.entries()]
    .map(([pattern, count]) => ({ pattern, count }))
    .sort((a, b) => b.count - a.count || HOOK_PATTERN_LABEL[a.pattern].localeCompare(HOOK_PATTERN_LABEL[b.pattern]));

  return {
    count: items.length,
    viralCount: items.filter((item) => item.level === 'viral').length,
    avgMultiplier,
    topPattern: patternCounts[0]?.pattern ?? null,
    patternCounts,
  };
}
