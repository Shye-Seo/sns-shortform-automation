import { describe, expect, it } from 'vitest';
import {
  OSMU_LIMITS,
  buildBeatTimeline,
  buildHashtags,
  convertToOsmu,
  splitForThreads,
} from '../src/services/osmuConverter';
import type { SceneDraft } from '../src/services/scriptEngine';
import { draftBeatScene } from '../web/model/studio';
import { classifyTopic } from '../src/services/topicProfile';

/**
 * The promise of the converter is narrow and testable: the captions say what the
 * video says. These tests edit a studio draft and read the caption back, rather
 * than comparing strings the converter itself produced from a topic.
 */

const JEJU = '겨울 제주 여행 2박3일 코스';
const KITCHEN = '부산 신혼집 3평 주방 수납 정리법';

function draftsFor(topic = JEJU, durationSec = 45): SceneDraft[] {
  return draftBeatScene(topic, durationSec, 0, 'auto');
}

describe('convertToOsmu', () => {
  it('returns the three formats in publishing order', () => {
    const result = convertToOsmu({ topic: JEJU, scenes: draftsFor(), durationSec: 45 });

    expect(result.formats.map((format) => format.id)).toEqual(['reels', 'shorts', 'summary']);
    expect(result.formats.map((format) => format.label)).toEqual([
      '인스타그램 릴스 캡션',
      '유튜브 쇼츠 설명',
      '블로그 · 스레드 요약 포스트',
    ]);
  });

  it('writes the caption from the edited script, not from the topic', () => {
    const scenes = draftsFor();
    const edited = scenes.map((scene, index) =>
      index === 2 ? { ...scene, narration: '수납칸은 세로로 세우고 앞쪽 20cm만 남깁니다.' } : scene,
    );
    const result = convertToOsmu({ topic: JEJU, scenes: edited, durationSec: 45 });
    const reels = result.formats.find((format) => format.id === 'reels');

    expect(reels?.text).toContain('수납칸은 세로로 세우고 앞쪽 20cm만 남깁니다.');
    // 편집한 대본이 아니면 나올 수 없는 문장이 빠져 있는지도 확인한다.
    expect(convertToOsmu({ topic: JEJU, scenes, durationSec: 45 }).formats[0]!.text).not.toContain(
      '앞쪽 20cm만',
    );
  });

  it('keeps the Reels caption inside the platform limit with 5–8 tags and a save CTA', () => {
    const result = convertToOsmu({ topic: JEJU, scenes: draftsFor(), durationSec: 45 });
    const reels = result.formats[0]!;

    expect(reels.chars).toBeLessThanOrEqual(OSMU_LIMITS.reelsCaption);
    expect(reels.hashtags.length).toBeGreaterThanOrEqual(OSMU_LIMITS.reelsHashtagMin);
    expect(reels.hashtags.length).toBeLessThanOrEqual(OSMU_LIMITS.reelsHashtagMax);
    expect(reels.hashtags.every((tag) => tag.startsWith('#'))).toBe(true);
    expect(reels.text).toContain('저장');
    expect(reels.checks.every((check) => check.ok)).toBe(true);
  });

  it('writes a Shorts title within 40 chars and a timeline that ascends', () => {
    const result = convertToOsmu({ topic: KITCHEN, scenes: draftsFor(KITCHEN), durationSec: 45 });
    const shorts = result.formats.find((format) => format.id === 'shorts')!;
    const timelineCheck = shorts.checks.find((check) => check.id === 'timeline');

    expect(shorts.hashtags.length).toBeLessThanOrEqual(OSMU_LIMITS.shortsHashtagMax);
    expect(timelineCheck?.ok).toBe(true);
    expect(shorts.text).toContain('타임라인');
    expect(shorts.text).toMatch(/\d{2}:\d{2} 훅/);
    expect(shorts.chars).toBeLessThanOrEqual(OSMU_LIMITS.shortsDescription);
  });

  it('splits the summary into Threads posts that each fit 500 characters', () => {
    const result = convertToOsmu({ topic: JEJU, scenes: draftsFor(), durationSec: 45 });
    const summary = result.formats.find((format) => format.id === 'summary')!;

    expect(summary.threads?.length).toBeGreaterThanOrEqual(1);
    expect(summary.threads!.every((chunk) => chunk.length <= OSMU_LIMITS.threadsPost)).toBe(true);
    expect(summary.threads!.join('\n\n')).toContain(summary.hashtags[0]!);
    expect(summary.text.length).toBeGreaterThan(250);
    expect(summary.checks.find((check) => check.id === 'thread-limit')?.ok).toBe(true);
  });

  it('uses the selected blog platform on the summary format', () => {
    const result = convertToOsmu({
      topic: JEJU,
      scenes: draftsFor(),
      durationSec: 45,
      platform: 'tistory',
    });
    expect(result.formats.find((format) => format.id === 'summary')?.channel).toBe('tistory');
  });

  it('warns about a hook that overruns the 3.5s window and about missing beats', () => {
    const longHook = Array.from({ length: 12 }, () => '아주 긴 훅 문장입니다').join(' ');
    const longHookResult = convertToOsmu({
      topic: JEJU,
      scenes: [
        { beat: 'hook', narration: longHook },
        ...draftsFor().filter((scene) => scene.beat !== 'hook'),
      ],
      durationSec: 45,
    });
    expect(longHookResult.warnings.join(' ')).toContain('3.5초');

    const noHook = convertToOsmu({
      topic: JEJU,
      scenes: [{ beat: 'problem', narration: '동선을 안 짜면 매번 다시 검색합니다.' }],
      durationSec: 30,
    });
    expect(noHook.warnings.join(' ')).toContain('훅 비트');
    expect(noHook.warnings.join(' ')).toContain('해결 단계');
  });

  it('is deterministic for the same topic and script', () => {
    const scenes = draftsFor();
    const first = convertToOsmu({ topic: JEJU, scenes, durationSec: 45 });
    const second = convertToOsmu({ topic: JEJU, scenes, durationSec: 45 });

    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(first.engine).toBe('osmu-rule-engine');
  });
});

describe('buildBeatTimeline', () => {
  it('fits the measured speech length into the target duration', () => {
    const beats = buildBeatTimeline(draftsFor(KITCHEN), { durationSec: 30, language: 'ko' });

    expect(beats.length).toBeGreaterThanOrEqual(4);
    expect(beats[0]!.startSec).toBe(0);
    for (const beat of beats) {
      expect(beat.endSec).toBeGreaterThan(beat.startSec);
      expect(beat.label.length).toBeGreaterThan(0);
    }
    expect(beats[beats.length - 1]!.endSec).toBeLessThanOrEqual(30.5);
  });

  it('keeps ascending start times for every beat', () => {
    const beats = buildBeatTimeline(draftsFor(JEJU), { durationSec: 45, language: 'ko' });
    for (let index = 1; index < beats.length; index += 1) {
      expect(beats[index]!.startSec).toBeGreaterThanOrEqual(beats[index - 1]!.startSec);
    }
  });
});

describe('buildHashtags · splitForThreads', () => {
  it('deduplicates tags and respects the requested count', () => {
    const profile = classifyTopic(JEJU);
    const tags = buildHashtags(profile, 6);

    expect(tags).toHaveLength(6);
    expect(new Set(tags.map((tag) => tag.toLowerCase())).size).toBe(6);
    expect(tags.every((tag) => /^#[\p{L}\p{N}]+$/u.test(tag))).toBe(true);
  });

  it('splits a long paragraph at sentence boundaries under the limit', () => {
    const sentence = '이 문장은 스레드 한 글의 상한을 넘기지 않도록 자르는지 확인하는 문장입니다. ';
    const text = Array.from({ length: 30 }, () => sentence.repeat(2)).join('');
    const chunks = splitForThreads(text, 500);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 500)).toBe(true);
    expect(chunks.join('')).toContain('스레드 한 글의 상한');
  });
});
