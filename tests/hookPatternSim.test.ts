import { describe, expect, it } from 'vitest';
import {
  HOOK_PATTERN_IDS,
  HOOK_PATTERN_META,
  estimateHookPatterns,
  scoreHookPatterns,
  type HookPatternId,
} from '../src/services/hookPatternSim';
import { classifyTopic } from '../src/services/topicProfile';

const JEJU = '겨울 제주 여행 2박3일 코스';
const CHEONGYAK = '청약 1순위 조건 3가지';

function hooks(seconds: Partial<Record<HookPatternId, number>> = {}, text = '훅 문장입니다') {
  return HOOK_PATTERN_IDS.reduce(
    (acc, id) => {
      acc[id] = { text, seconds: seconds[id] ?? 2.4 };
      return acc;
    },
    {} as Record<HookPatternId, { text: string; seconds: number }>,
  );
}

describe('scoreHookPatterns', () => {
  it('returns four patterns in a fixed order with every rate in range', () => {
    const rows = scoreHookPatterns({ profile: classifyTopic(JEJU), hooks: hooks() });

    expect(rows.map((row) => row.id)).toEqual([...HOOK_PATTERN_IDS]);
    for (const row of rows) {
      expect(row.holdRate3s).toBeGreaterThan(0.3);
      expect(row.holdRate3s).toBeLessThanOrEqual(0.85);
      expect(row.saveRate).toBeGreaterThan(0.005);
      expect(row.saveRate).toBeLessThanOrEqual(0.12);
      expect(row.shareRate).toBeGreaterThan(0.002);
      expect(row.shareRate).toBeLessThanOrEqual(0.06);
      expect(row.example.length).toBeGreaterThan(0);
    }
  });

  it('marks one save leader and one share leader', () => {
    const rows = scoreHookPatterns({ profile: classifyTopic(JEJU), hooks: hooks() });
    const saveLeaders = rows.filter((row) => row.verdict.includes('저장'));
    const shareLeaders = rows.filter((row) => row.verdict.includes('공유'));

    expect(saveLeaders).toHaveLength(1);
    expect(shareLeaders).toHaveLength(1);
  });

  it('penalises a hook that overruns the 3-second window', () => {
    const short = scoreHookPatterns({ profile: classifyTopic(JEJU), hooks: hooks({ question: 2.2 }) });
    const long = scoreHookPatterns({ profile: classifyTopic(JEJU), hooks: hooks({ question: 5.1 }) });

    const shortQuestion = short.find((row) => row.id === 'question')!;
    const longQuestion = long.find((row) => row.id === 'question')!;

    expect(longQuestion.holdRate3s).toBeLessThan(shortQuestion.holdRate3s);
    expect(longQuestion.saveRate).toBeLessThan(shortQuestion.saveRate);
    expect(longQuestion.factors.join(' ')).toContain('3.5초');
  });

  it('rewards the numbers pattern when the topic carries numbers', () => {
    const withNumbers = scoreHookPatterns({
      profile: classifyTopic(CHEONGYAK),
      hooks: hooks({ numbers: 2.4 }),
    });
    const withoutNumbers = scoreHookPatterns({
      profile: classifyTopic('주방 수납 정리'),
      hooks: hooks({ numbers: 2.4 }),
    });

    const a = withNumbers.find((row) => row.id === 'numbers')!;
    const b = withoutNumbers.find((row) => row.id === 'numbers')!;
    expect(a.factors.join(' ')).toContain('숫자');
    expect(a.saveRate).toBeGreaterThanOrEqual(b.saveRate);
  });

  it('applies the category save tendency as an explainable factor', () => {
    const recipe = scoreHookPatterns({ profile: classifyTopic('냉장고 재료로 10분 저녁'), hooks: hooks() });
    const checklist = recipe.find((row) => row.id === 'checklist')!;

    const question = recipe.find((row) => row.id === 'question')!;
    expect(checklist.factors.join(' ')).toContain('저장 성향');
    expect(checklist.saveRate).toBeGreaterThan(question.saveRate);
  });

  it('is deterministic', () => {
    const profile = classifyTopic(JEJU);
    expect(JSON.stringify(scoreHookPatterns({ profile, hooks: hooks() }))).toBe(
      JSON.stringify(scoreHookPatterns({ profile, hooks: hooks() })),
    );
  });
});

describe('estimateHookPatterns', () => {
  it('writes a real hook per pattern with the same topic', () => {
    const estimate = estimateHookPatterns({ topic: JEJU, durationSec: 45 });

    expect(estimate.rows).toHaveLength(4);
    expect(new Set(estimate.rows.map((row) => row.example)).size).toBeGreaterThan(1);
    for (const row of estimate.rows) {
      expect(row.hookSeconds).toBeGreaterThan(0);
      expect(HOOK_PATTERN_META[row.id].label).toBe(row.label);
    }
    expect(estimate.method).toContain('실측 아님');
    expect(estimate.notes.length).toBeGreaterThanOrEqual(2);
  });

  it('reports the leaders the rows agree on', () => {
    const estimate = estimateHookPatterns({ topic: CHEONGYAK, durationSec: 45 });
    const bestSave = estimate.rows.reduce((best, row) => (row.saveRate > best.saveRate ? row : best), estimate.rows[0]!);
    const bestShare = estimate.rows.reduce(
      (best, row) => (row.shareRate > best.shareRate ? row : best),
      estimate.rows[0]!,
    );

    expect(estimate.bestSave).toBe(bestSave.id);
    expect(estimate.bestShare).toBe(bestShare.id);
  });

  it('keeps the same result for the same variation and moves with it', () => {
    const first = estimateHookPatterns({ topic: JEJU, durationSec: 45, variation: 0 });
    const again = estimateHookPatterns({ topic: JEJU, durationSec: 45, variation: 0 });
    const next = estimateHookPatterns({ topic: JEJU, durationSec: 45, variation: 1 });

    expect(JSON.stringify(again)).toBe(JSON.stringify(first));
    expect(next.rows.map((row) => row.example)).not.toEqual(first.rows.map((row) => row.example));
  });
});
