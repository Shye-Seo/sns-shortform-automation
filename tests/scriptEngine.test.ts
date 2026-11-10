import { describe, expect, it } from 'vitest';
import {
  ScriptEngine,
  compressText,
  createScriptEngine,
  draftScenesHeuristic,
  fill,
  hasBatchim,
  keywordFor,
  planTimeBudget,
  type ScriptModel,
} from '../src/services/scriptEngine';
import { ShortformScriptSchema, safeParseScript } from '../src/types/script';
import { extractKeywords, topicHeadKeyword, wrapText } from '../src/lib/text';

const baseRequest = {
  topic: '부산 신혼집 3평 주방 수납 정리법',
  language: 'ko' as const,
  targetDurationSec: 45,
  speed: 1,
  hookType: 'question' as const,
  ctaGoal: 'save' as const,
  tone: 'friendly' as const,
};

describe('time budget', () => {
  it('reserves breathing room before spending speech time', () => {
    const budget = planTimeBudget({
      targetDurationSec: 60,
      language: 'ko',
      speed: 1,
      sceneCount: 6,
    });
    expect(budget.speechBudgetSec).toBeLessThan(60);
    expect(budget.gapBudgetSec).toBeGreaterThan(0.5);
    expect(budget.capacitySyllables).toBeGreaterThan(250);
    expect(budget.capacitySyllables).toBeLessThan(330);
  });

  it('never lets the hook take more than three seconds of speech', () => {
    const budget = planTimeBudget({
      targetDurationSec: 60,
      language: 'ko',
      speed: 1,
      sceneCount: 4,
    });
    expect(budget.sceneCapsSec.hook).toBeLessThanOrEqual(3.25);
  });

  it('gives fewer syllables to faster targets', () => {
    const short = planTimeBudget({ targetDurationSec: 30, language: 'ko', speed: 1, sceneCount: 5 });
    const long = planTimeBudget({ targetDurationSec: 60, language: 'ko', speed: 1, sceneCount: 5 });
    expect(long.capacitySyllables).toBeGreaterThan(short.capacitySyllables);
  });

  it('speeds up articulation without shrinking pauses proportionally', () => {
    const normal = planTimeBudget({ targetDurationSec: 45, language: 'ko', speed: 1, sceneCount: 6 });
    const fast = planTimeBudget({ targetDurationSec: 45, language: 'ko', speed: 1.2, sceneCount: 6 });
    expect(fast.capacitySyllables).toBeGreaterThan(normal.capacitySyllables);
    expect(fast.speechBudgetSec).toBe(normal.speechBudgetSec);
  });
});

describe('script compression', () => {
  it('removes filler words before touching sentences', () => {
    const result = compressText('사실 이건 진짜 그냥 약간 문제입니다', {
      language: 'ko',
      speed: 1,
      maxSec: 1.2,
    });
    expect(result.text).not.toContain('사실');
    expect(result.text).not.toContain('진짜');
    expect(result.afterSec).toBeLessThan(result.beforeSec);
    expect(result.passes.some((pass) => pass.pass === 'filler' || pass.pass === 'contraction')).toBe(true);
  });

  it('drops a low-value sentence but keeps the first one', () => {
    const text = '기준을 하나로 줄입니다. 그리고 사실 별로 중요하지 않은 덧붙임 문장입니다.';
    const result = compressText(text, {
      language: 'ko',
      speed: 1,
      maxSec: 2,
      protectFirstSentence: true,
    });
    expect(result.text.startsWith('기준을 하나로 줄입니다')).toBe(true);
    expect(result.text.length).toBeLessThan(text.length);
  });

  it('strips parenthetical asides first', () => {
    const result = compressText('수납은 두 칸이면 됩니다 (사실 이건 사람마다 다릅니다)', {
      language: 'ko',
      speed: 1,
      maxSec: 2.4,
    });
    expect(result.text).not.toContain('사실 이건');
  });

  it('never shrinks a line to nothing', () => {
    const result = compressText('됩니다', { language: 'ko', speed: 1, maxSec: 0.2 });
    expect(result.text.trim().length).toBeGreaterThan(0);
  });

  it('records how much time each pass saved', () => {
    const result = compressText(
      '사실 이건 진짜 그냥 약간 복잡한 이야기인데, 제가 보기에는 결국 기준을 하나로 줄이는 게 중요합니다.',
      { language: 'ko', speed: 1, maxSec: 1.5 },
    );
    expect(result.passes.length).toBeGreaterThan(0);
    const saved = result.passes.reduce((sum, pass) => sum + pass.savedSec, 0);
    expect(saved).toBeGreaterThan(0);
    expect(result.beforeSec - result.afterSec).toBeCloseTo(saved, 1);
  });
});

describe('korean templates', () => {
  it('selects the right particle for a final consonant', () => {
    expect(hasBatchim('주방')).toBe(true);
    expect(hasBatchim('수납')).toBe(true);
    expect(hasBatchim('신혼집')).toBe(true);
    expect(hasBatchim('나무')).toBe(false);
  });

  it('fills 은/는 without doubling a template particle', () => {
    expect(fill('{keun} 중요합니다', '주방', 'ko')).toBe('주방은 중요합니다');
    expect(fill('{keun} 중요합니다', '수납', 'ko')).toBe('수납은 중요합니다');
    expect(fill('{k}에서 시작', '주방', 'ko')).toBe('주방에서 시작');
  });

  it('reads the subject that sits before the format word', () => {
    expect(topicHeadKeyword('부산 신혼집 3평 주방 수납 정리법', 'ko')).toBe('주방수납');
    expect(topicHeadKeyword('주방 수납', 'ko')).toBe('수납');
  });

  it('does not treat conjugated verbs as keywords', () => {
    const keywords = extractKeywords('돌아왔죠 번거로운 동작에만 주방수납 주방수납', 'ko');
    expect(keywords.map((keyword) => keyword.term)).not.toContain('돌아왔죠');
    expect(keywords.map((keyword) => keyword.term)).toContain('주방수납');
  });

  it('picks the topic head as the hook keyword', () => {
    const keyword = keywordFor(baseRequest, []);
    expect(keyword).toBe('주방수납');
  });
});

describe('heuristic writer', () => {
  const drafts = draftScenesHeuristic(
    { request: baseRequest, keywords: [] },
    { targetDurationSec: 45 },
  );

  it('produces the four beats in order', () => {
    expect(drafts[0]?.beat).toBe('hook');
    expect(drafts[drafts.length - 1]?.beat).toBe('cta');
    expect(drafts.some((draft) => draft.beat === 'problem')).toBe(true);
    expect(drafts.filter((draft) => draft.beat === 'solution').length).toBeGreaterThanOrEqual(3);
  });

  it('uses the source material for the steps when it is provided', () => {
    const withRaw = draftScenesHeuristic(
      {
        request: {
          ...baseRequest,
          rawText:
            '작은 주방은 수납장을 늘리는 게 답이 아닙니다. 먼저 일주일 동안 쓰지 않은 물건을 바구니에 담아보세요. 매일 쓰는 도구만 첫 줄에 두면 됩니다.',
        },
        keywords: [],
      },
      { targetDurationSec: 45 },
    );
    const stepTexts = withRaw.filter((draft) => draft.beat === 'solution').map((draft) => draft.narration);
    expect(stepTexts.join(' ')).toContain('수납장');
    expect(stepTexts.join(' ')).not.toContain('첫째,');
  });
});

describe('crafting a full script', () => {
  it('builds a schema-valid 45 second script', async () => {
    const { script } = await createScriptEngine().craft(baseRequest);
    expect(() => ShortformScriptSchema.parse(script)).not.toThrow();
    expect(script.metrics.totalDurationSec).toBeLessThanOrEqual(45);
    expect(script.metrics.hookDurationSec).toBeLessThanOrEqual(3.5);
    expect(script.scenes[script.scenes.length - 1]?.beat).toBe('cta');
    expect(script.caption.length).toBeLessThanOrEqual(2200);
    expect(script.hashtags.length).toBeGreaterThanOrEqual(3);
  });

  it('never exceeds the 60 second platform ceiling', async () => {
    const { script } = await createScriptEngine().craft({ ...baseRequest, targetDurationSec: 60 });
    expect(script.metrics.totalDurationSec).toBeLessThanOrEqual(60);
  });

  it('keeps the timeline contiguous', async () => {
    const { script } = await createScriptEngine().craft(baseRequest);
    let cursor = 0;
    for (const scene of script.scenes) {
      expect(scene.startSec).toBeCloseTo(cursor, 2);
      cursor += scene.durationSec;
    }
    expect(cursor).toBeCloseTo(script.metrics.totalDurationSec, 2);
  });

  it('compresses when the target is tight', async () => {
    const longTopic =
      '부산 신혼집 3평 주방 수납 정리법과 살림 도구 선택 기준, 그리고 매일 쓰는 조리도구 배치 순서에 대한 아주 긴 설명입니다';
    const { script } = await createScriptEngine().craft({
      ...baseRequest,
      topic: longTopic,
      targetDurationSec: 20,
    });
    expect(script.compression.applied).toBe(true);
    expect(script.compression.savedSec).toBeGreaterThan(0);
    expect(script.metrics.totalDurationSec).toBeLessThanOrEqual(20);
  });

  it('falls back to the heuristic writer when the model fails', async () => {
    const brokenModel: ScriptModel = {
      name: 'broken',
      complete: async () => 'not json at all',
    };
    const engine = new ScriptEngine({ model: brokenModel });
    const { script, warnings } = await engine.craft(baseRequest);
    expect(script.generationSource).toBe('heuristic-fallback');
    expect(warnings[0]).toContain('model draft rejected');
    expect(script.scenes.length).toBeGreaterThanOrEqual(4);
  });

  it('accepts a valid model draft', async () => {
    const goodModel: ScriptModel = {
      name: 'fake',
      complete: async () =>
        JSON.stringify({
          title: '주방 수납 3단계',
          scenes: [
            { beat: 'hook', narration: '주방수납, 아직도 이렇게 하고 있나요?' },
            { beat: 'problem', narration: '대부분 수납장을 늘리려고 합니다.' },
            { beat: 'solution', narration: '일주일 안 쓴 물건부터 덜어내세요.' },
            { beat: 'solution', narration: '매일 쓰는 것만 손이 닿는 곳에 두세요.' },
            { beat: 'cta', narration: '저장해두고 천천히 따라 해보세요.' },
          ],
        }),
    };
    const { script } = await new ScriptEngine({ model: goodModel }).craft(baseRequest);
    expect(script.generationSource).toBe('model');
    expect(script.title).toBe('주방 수납 3단계');
  });

  it('repairs a model draft that forgets the CTA', async () => {
    const model: ScriptModel = {
      name: 'chatty',
      complete: async () =>
        JSON.stringify({
          scenes: [
            { beat: 'hook', narration: '훅입니다' },
            { beat: 'problem', narration: '문제입니다' },
            { beat: 'solution', narration: '해결책입니다' },
          ],
        }),
    };
    const { script } = await new ScriptEngine({ model }).craft(baseRequest);
    expect(script.scenes[script.scenes.length - 1]?.beat).toBe('cta');
    expect(script.scenes[0]?.beat).toBe('hook');
  });

  it('rejects an invalid script through the schema', () => {
    const result = safeParseScript({ nonsense: true });
    expect(result.success).toBe(false);
  });

  it('keeps an explicit hashtag set inside the platform limit', async () => {
    const { script } = await createScriptEngine().craft({
      ...baseRequest,
      hashtags: Array.from({ length: 28 }, (_, index) => `#태그${index}`),
    });
    expect(script.hashtags.length).toBeLessThanOrEqual(30);
    expect(new Set(script.hashtags).size).toBe(script.hashtags.length);
  });

  it('writes captions that fit inside the platform limit', async () => {
    const { script } = await createScriptEngine().craft({ ...baseRequest, targetDurationSec: 60 });
    expect(script.caption).toContain(script.hashtags[0] as string);
  });
});

describe('line width sanity', () => {
  it('keeps a two-line caption under the reel text box width', () => {
    const lines = wrapText('기준을 하나로 줄입니다', {
      maxWidthPx: 760,
      fontSizePx: 96,
      maxLines: 2,
    });
    expect(lines.length).toBe(2);
  });
});
