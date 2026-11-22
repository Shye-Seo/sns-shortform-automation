import type { CreatorCut, KenBurns } from './types';

/**
 * 컷 배열 → 절대 시간 타임라인.
 *
 * 엔진의 buildTimeline과 같은 규칙(앞 컷이 끝나는 곳에서 다음 컷이 시작)을 쓰지만,
 * 여기서는 발화량이 아니라 사용자가 정한 컷 길이가 시간을 정한다. 미리보기, 영상
 * 렌더, 카드뉴스가 모두 이 한 함수의 결과를 읽는다.
 */

export interface CreatorSegment {
  cutId: string;
  cut: CreatorCut;
  index: number;
  startSec: number;
  endSec: number;
  durationSec: number;
}

export interface CreatorTimeline {
  segments: CreatorSegment[];
  totalSec: number;
  /** 컷 사이 겹침(전환) 길이. 길이 자체는 줄이지 않는다. */
  transitionSec: number;
  frameCount: number;
  fps: number;
}

export const DEFAULT_TRANSITION_SEC = 0.4;

export function buildCreatorTimeline(
  cuts: readonly CreatorCut[],
  options: { fps?: number; transitionSec?: number; minCutSec?: number } = {},
): CreatorTimeline {
  const fps = options.fps ?? 30;
  const transitionSec = options.transitionSec ?? DEFAULT_TRANSITION_SEC;
  const minCutSec = options.minCutSec ?? 0.5;
  const segments: CreatorSegment[] = [];
  let cursor = 0;

  cuts.forEach((cut, index) => {
    const durationSec = Math.max(minCutSec, Number.isFinite(cut.durationSec) ? cut.durationSec : minCutSec);
    segments.push({
      cutId: cut.id,
      cut,
      index,
      startSec: round(cursor),
      endSec: round(cursor + durationSec),
      durationSec: round(durationSec),
    });
    cursor += durationSec;
  });

  const totalSec = round(cursor);
  return {
    segments,
    totalSec,
    transitionSec,
    frameCount: Math.max(1, Math.round(totalSec * fps)),
    fps,
  };
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** t초에 화면에 있는 컷. 범위를 벗어나면 처음/마지막 컷으로 붙잡는다. */
export function segmentAt(timeline: CreatorTimeline, sec: number): CreatorSegment | null {
  if (timeline.segments.length === 0) return null;
  const t = clamp(sec, 0, Math.max(0, timeline.totalSec - 0.0001));
  for (const segment of timeline.segments) {
    if (t >= segment.startSec && t < segment.endSec) return segment;
  }
  return timeline.segments[timeline.segments.length - 1] ?? null;
}

/** 컷 안에서의 진행률 0~1. */
export function cutProgress(segment: CreatorSegment, sec: number): number {
  if (segment.durationSec <= 0) return 0;
  return clamp((sec - segment.startSec) / segment.durationSec, 0, 1);
}

/** 다음/이전 컷으로 이동할 때 쓰는 시작 시각. */
export function segmentStart(segment: CreatorSegment): number {
  return segment.startSec + 0.001;
}

/** 전환 중이면 진행률을 돌려준다. 1을 넘으면 전환이 끝난 상태. */
export function transitionProgress(segment: CreatorSegment, sec: number, transitionSec: number): number {
  if (segment.index === 0 || transitionSec <= 0) return 1;
  const elapsed = sec - segment.startSec;
  if (elapsed >= transitionSec) return 1;
  return clamp(elapsed / transitionSec, 0, 1);
}

export interface KenBurnsFrame {
  /** 1 = 원본 크기. 1.08 = 8% 확대. */
  scale: number;
  /** -1(왼쪽) ~ 1(오른쪽) 정규화 이동. */
  panX: number;
  /** -1(위) ~ 1(아래). */
  panY: number;
}

export const KEN_BURNS_MAX_ZOOM = 0.08;

/**
 * 켄 번스 곡선. 정지 사진도 3초 동안 8%만 움직여야 "떨림"이 아니라 "호흡"으로
 * 보인다. 이동(pan)은 확대된 여백 안에서만 움직인다(빈 배경이 보이지 않게).
 */
export function kenBurnsAt(kind: KenBurns, progress: number): KenBurnsFrame {
  const p = clamp(progress, 0, 1);
  const ease = p < 0.5 ? 2 * p * p : 1 - 2 * (1 - p) * (1 - p);
  switch (kind) {
    case 'in':
      return { scale: 1 + KEN_BURNS_MAX_ZOOM * ease, panX: 0, panY: 0 };
    case 'out':
      return { scale: 1 + KEN_BURNS_MAX_ZOOM * (1 - ease), panX: 0, panY: 0 };
    case 'left':
      return { scale: 1 + KEN_BURNS_MAX_ZOOM, panX: 1 - 2 * ease, panY: 0 };
    case 'right':
      return { scale: 1 + KEN_BURNS_MAX_ZOOM, panX: -1 + 2 * ease, panY: 0 };
    case 'none':
    default:
      return { scale: 1, panX: 0, panY: 0 };
  }
}

export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

export function formatSeconds(sec: number): string {
  const total = Math.max(0, sec);
  const minutes = Math.floor(total / 60);
  const seconds = total - minutes * 60;
  return `${minutes}:${seconds.toFixed(1).padStart(4, '0')}`;
}

/** 렌더 계획 — 초 단위 진행률을 프레임 번호로 바꿔 진행 바가 실제와 맞게 한다. */
export function planFrames(totalSec: number, fps: number): { totalFrames: number; frameDurationSec: number } {
  const safeFps = Math.max(1, Math.round(fps));
  return { totalFrames: Math.max(1, Math.round(totalSec * safeFps)), frameDurationSec: 1 / safeFps };
}

/** 타임라인을 사람이 읽는 한 줄로. */
export function describeTimeline(timeline: CreatorTimeline): string {
  const count = timeline.segments.length;
  const cuts = timeline.segments.map((segment) => segment.durationSec.toFixed(1));
  return `${count}컷 · ${timeline.totalSec.toFixed(1)}초 (${cuts.join(' + ')})`;
}

/** 컷 순서 이동. index가 범위를 벗어나면 그대로 돌려준다. */
export function moveCut<T>(items: readonly T[], from: number, to: number): T[] {
  if (from === to || from < 0 || from >= items.length || to < 0 || to >= items.length) return [...items];
  const next = [...items];
  const [item] = next.splice(from, 1);
  if (item === undefined) return [...items];
  next.splice(to, 0, item);
  return next;
}
