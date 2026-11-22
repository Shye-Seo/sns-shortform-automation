import { describe, expect, it } from 'vitest';
import {
  buildCreatorTimeline,
  cutProgress,
  describeTimeline,
  formatSeconds,
  kenBurnsAt,
  moveCut,
  planFrames,
  segmentAt,
  transitionProgress,
} from '../web/model/creator/timeline';
import { makeCut, sampleCuts } from '../web/model/creator/types';

/** 컷 길이 → 절대 시간. 미리보기·렌더·카드뉴스가 모두 이 계산을 공유한다. */

describe('creator timeline', () => {
  const cuts = [2, 3, 1.5].map((durationSec, index) =>
    makeCut({ caption: `${index + 1}번`, durationSec, kind: 'placeholder' }),
  );

  it('컷 길이를 이어 붙여 전체 시간을 만든다', () => {
    const timeline = buildCreatorTimeline(cuts, { fps: 30 });
    expect(timeline.segments.map((segment) => segment.durationSec)).toEqual([2, 3, 1.5]);
    expect(timeline.totalSec).toBe(6.5);
    expect(timeline.frameCount).toBe(195);
    expect(timeline.fps).toBe(30);
    for (let index = 1; index < timeline.segments.length; index += 1) {
      expect(timeline.segments[index]!.startSec).toBeCloseTo(timeline.segments[index - 1]!.endSec, 3);
    }
  });

  it('재생 위치에 맞는 컷을 돌려주고, 경계에서는 다음 컷부터 시작한다', () => {
    const timeline = buildCreatorTimeline(cuts);
    expect(segmentAt(timeline, 0)!.index).toBe(0);
    expect(segmentAt(timeline, 1.999)!.index).toBe(0);
    expect(segmentAt(timeline, 2)!.index).toBe(1);
    expect(segmentAt(timeline, 5.2)!.index).toBe(2);
    expect(segmentAt(timeline, 99)!.index).toBe(2);
    expect(segmentAt(timeline, -5)!.index).toBe(0);
  });

  it('컷 안 진행률과 전환 진행률을 0~1로 자른다', () => {
    const timeline = buildCreatorTimeline(cuts, { transitionSec: 0.4 });
    const second = timeline.segments[1]!;
    expect(cutProgress(second, 2)).toBe(0);
    expect(cutProgress(second, 3.5)).toBeCloseTo(0.5, 3);
    expect(cutProgress(second, 9)).toBe(1);
    expect(transitionProgress(second, 2.1, 0.4)).toBeCloseTo(0.25, 3);
    expect(transitionProgress(second, 3.4, 0.4)).toBe(1);
    // 첫 컷은 넘어올 이전 화면이 없다.
    expect(transitionProgress(timeline.segments[0]!, 0, 0.4)).toBe(1);
  });

  it('켄 번스 이동은 확대 여백 안에서만 움직인다', () => {
    expect(kenBurnsAt('none', 0.5)).toEqual({ scale: 1, panX: 0, panY: 0 });
    expect(kenBurnsAt('in', 1).scale).toBeCloseTo(1.08, 3);
    expect(kenBurnsAt('out', 0).scale).toBeCloseTo(1.08, 3);
    const left = kenBurnsAt('left', 0);
    const leftEnd = kenBurnsAt('left', 1);
    expect(left.panX).toBeCloseTo(1, 3);
    expect(leftEnd.panX).toBeCloseTo(-1, 3);
    expect(kenBurnsAt('right', 0).panX).toBeCloseTo(-1, 3);
    for (const value of [-1, 0, 1]) {
      const frame = kenBurnsAt('in', value);
      expect(frame.panX).toBe(0);
      expect(frame.scale).toBeGreaterThanOrEqual(1);
    }
  });

  it('컷이 없으면 빈 타임라인이 되고 그리기 대상도 없다', () => {
    const timeline = buildCreatorTimeline([]);
    expect(timeline.segments).toEqual([]);
    expect(timeline.totalSec).toBe(0);
    expect(segmentAt(timeline, 0)).toBeNull();
  });

  it('이상한 길이는 최소 0.5초로 보정한다', () => {
    const weird = [makeCut({ durationSec: 0 }), makeCut({ durationSec: Number.NaN })];
    const timeline = buildCreatorTimeline(weird);
    expect(timeline.segments.every((segment) => segment.durationSec >= 0.5)).toBe(true);
  });

  it('순서 이동은 범위를 벗어나면 그대로 둔다', () => {
    const items = ['a', 'b', 'c'];
    expect(moveCut(items, 0, 2)).toEqual(['b', 'c', 'a']);
    expect(moveCut(items, 2, 0)).toEqual(['c', 'a', 'b']);
    expect(moveCut(items, 0, 5)).toEqual(items);
    expect(moveCut(items, -1, 1)).toEqual(items);
  });

  it('샘플 컷은 네 개이고 각 3초', () => {
    const samples = sampleCuts();
    expect(samples).toHaveLength(4);
    expect(samples.every((cut) => cut.durationSec === 3)).toBe(true);
    expect(samples[0]!.caption).toContain('3평');
  });

  it('시간 표기와 렌더 프레임 계획', () => {
    expect(formatSeconds(6.5)).toBe('0:06.5');
    expect(formatSeconds(65)).toBe('1:05.0');
    expect(planFrames(6.5, 30)).toEqual({ totalFrames: 195, frameDurationSec: 1 / 30 });
    expect(describeTimeline(buildCreatorTimeline(cuts))).toContain('3컷');
  });
});
