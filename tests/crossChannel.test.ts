import { describe, expect, it } from 'vitest';
import { analyzeReference } from '../src/services/contentAnalyzer';
import { planCrossChannel, buildPlannerPrompt, applyLlmPlan } from '../src/services/crossChannelPlanner';
import { planWithClaude, sanitizePayload, type FetchLike } from '../src/services/llmPlanner';
import { planToMarkdown } from '../src/services/planMarkdown';
import { PATTERN_LIBRARY } from '../src/services/patternLibrary';
import { classifyTopic } from '../src/services/topicProfile';
import { badgeFor, writeTopicDrafts } from '../src/services/topicDraftWriter';
import { buildStudioModel, draftBeatScene } from '../web/model/studio';

/**
 * The bug that started this: a topic field that did not change the script, and
 * a "regenerate" button that returned the same words. These tests lock the
 * replacement behaviour — topic-aware lines, a new angle per press, and the
 * cross-channel plan built from the same steps.
 */

const JEJU = '겨울 제주 여행 2박3일 코스';
const MASSAGER = '팔꿈치 마사지기 리뷰';
const CHEONGYAK = '청약 1순위 조건';
const DINNER = '냉장고 재료로 10분 저녁';

describe('topic profile', () => {
  it('classifies the topic into the lever the script should pull', () => {
    expect(classifyTopic(JEJU).category).toBe('travel');
    expect(classifyTopic(MASSAGER).category).toBe('product');
    expect(classifyTopic(CHEONGYAK).category).toBe('info');
    expect(classifyTopic(DINNER).category).toBe('recipe');
    expect(classifyTopic(JEJU).detail).toBe('이동 동선');
  });

  it('strips review/format words from the subject but keeps the numbers', () => {
    const product = classifyTopic(MASSAGER);
    expect(product.subject).toBe('팔꿈치 마사지기');
    expect(product.intent).toBe('review');
    expect(classifyTopic(CHEONGYAK).subject).toBe('청약 1순위');
    expect(classifyTopic('2026년 청약통장 조건 정리').category).toBe('info');
  });

  it('derives the on-screen badge from the topic instead of a fixed label', () => {
    expect(badgeFor(classifyTopic(MASSAGER))).toBe('팔꿈치 마사지기');
    expect(badgeFor(classifyTopic(JEJU))).toContain('2박3일');
    const model = buildStudioModel({
      topic: JEJU,
      durationSec: 45,
      speed: 1,
      language: 'ko',
      drafts: [],
      compress: true,
    });
    expect(model.badgeText).not.toBe('KITCHEN 3평');
    expect(model.layout.badge).not.toBeNull();
  });
});

describe('regeneration variety', () => {
  it('gives every press a different angle and a different hook', () => {
    const plans = Array.from({ length: 6 }, (_, variation) =>
      planCrossChannel({ topic: JEJU, durationSec: 45, variation }),
    );
    const hooks = plans.map((plan) => plan.shorts.scenes[0]?.narration);
    expect(new Set(hooks).size).toBe(6);

    const angles = plans.map((plan) => plan.angle.id);
    expect(new Set(angles).size).toBe(5); // five angles, then the cycle repeats
    expect(angles[0]).toBe(angles[5]);

    const captions = new Set(plans.map((plan) => plan.shorts.caption));
    expect(captions.size).toBe(6);
  });

  it('changes the step selection as well as the hook', () => {
    const first = planCrossChannel({ topic: JEJU, durationSec: 45, variation: 0 });
    const later = planCrossChannel({ topic: JEJU, durationSec: 45, variation: 2 });
    const stepsOf = (plan: ReturnType<typeof planCrossChannel>): string =>
      plan.shorts.scenes
        .filter((scene) => scene.beat === 'solution')
        .map((scene) => scene.narration)
        .join(' ');
    expect(stepsOf(first)).not.toBe(stepsOf(later));
  });

  it('never leaves the previous topic in the script, captions or cues', () => {
    const kitchen = buildStudioModel({
      topic: '부산 신혼집 3평 주방 수납 정리법',
      durationSec: 45,
      speed: 1,
      language: 'ko',
      drafts: draftBeatScene('부산 신혼집 3평 주방 수납 정리법', 45, 0),
      compress: true,
    });
    const travel = buildStudioModel({
      topic: JEJU,
      durationSec: 45,
      speed: 1,
      language: 'ko',
      drafts: draftBeatScene(JEJU, 45, 0),
      compress: true,
    });
    const kitchenText = kitchen.scenes.map((scene) => scene.narration).join(' ');
    const travelText = travel.scenes.map((scene) => scene.narration).join(' ');
    expect(kitchenText).not.toBe(travelText);
    expect(travelText).not.toContain('주방');
    expect(travelText).toContain('제주');

    const kitchenCues = kitchen.cues.map((cue) => cue.lines.join(' ')).join(' ');
    const travelCues = travel.cues.map((cue) => cue.lines.join(' ')).join(' ');
    expect(travelCues).not.toBe(kitchenCues);
    expect(travelCues).not.toContain('주방');
  });

  it('writes category-specific lines rather than swapping the noun', () => {
    const recipe = planCrossChannel({ topic: DINNER, variation: 0 });
    const info = planCrossChannel({ topic: CHEONGYAK, variation: 0 });
    const recipeText = recipe.shorts.scenes.map((scene) => scene.narration).join(' ');
    const infoText = info.shorts.scenes.map((scene) => scene.narration).join(' ');
    expect(recipeText).toMatch(/재료|간|조리|접시/);
    expect(infoText).toMatch(/자격|서류|공고|신청/);
    expect(recipeText).not.toMatch(/자격 조건을 한 줄로/);
  });

  it('survives the one-character and empty states a topic field passes through', () => {
    for (const topic of ['', ' ', '겨', '1', '겨울']) {
      const model = buildStudioModel({
        topic,
        durationSec: 45,
        speed: 1,
        language: 'ko',
        drafts: draftBeatScene(topic, 45, 0),
        compress: true,
      });
      expect(model.scenes.length).toBeGreaterThanOrEqual(4);
      expect(model.totalDurationSec).toBeGreaterThan(0);
    }
  });

  it('keeps the hook inside the 3.5s ceiling after compression', () => {
    for (const topic of [JEJU, MASSAGER, CHEONGYAK, DINNER]) {
      const model = buildStudioModel({
        topic,
        durationSec: 45,
        speed: 1,
        language: 'ko',
        drafts: draftBeatScene(topic, 45, 0),
        compress: true,
      });
      expect(model.scenes[0]?.durationSec).toBeLessThanOrEqual(3.5);
      expect(model.overrunSec).toBe(0);
      expect(model.totalDurationSec).toBeLessThanOrEqual(45.01);
    }
  });
});

describe('cross-channel plan', () => {
  it('links every shorts scene to a longform chapter and a blog heading', () => {
    const plan = planCrossChannel({ topic: JEJU, variation: 0 });
    expect(plan.longform.chapters.length).toBeGreaterThanOrEqual(4);
    expect(plan.blog.outline.length).toBeGreaterThanOrEqual(4);
    expect(plan.blog.faq).toHaveLength(2);
    expect(plan.repurpose).toHaveLength(plan.shorts.scenes.length);
    for (const row of plan.repurpose) {
      expect(row.longformChapter).not.toBe('-');
      expect(row.blogHeading).not.toBe('-');
    }

    // Chapter start times are laid end to end, not all at 0:00.
    const starts = plan.longform.chapters.map((chapter) => chapter.startSec);
    for (let index = 1; index < starts.length; index += 1) {
      expect(starts[index]!).toBeGreaterThan(starts[index - 1]!);
    }
    expect(plan.longform.estimatedMinutes).toBeGreaterThan(2);
  });

  it('never leaks a template placeholder into the plan', () => {
    const plan = planCrossChannel({ topic: JEJU, variation: 3 });
    const text = JSON.stringify(plan);
    expect(text).not.toContain('{s}');
    expect(text).not.toContain('{detail}');
    expect(text).not.toContain('{badge}');
    expect(text).not.toContain('{b}');
  });

  it('switches the blog skeleton to the chosen platform', () => {
    const naver = planCrossChannel({ topic: JEJU, blogPlatform: 'naver-blog' });
    const wordpress = planCrossChannel({ topic: JEJU, blogPlatform: 'wordpress' });
    expect(naver.blog.targetChars).toBe(2000);
    expect(wordpress.blog.targetChars).toBe(2400);
    expect(naver.blog.hashtags.length).toBeGreaterThan(wordpress.blog.hashtags.length);
    expect(wordpress.blog.seoNotes.join(' ')).toMatch(/내부 링크|FAQ/);
    expect(naver.blog.metaDescription.length).toBeLessThanOrEqual(155);
  });

  it('applies the reference hook angle and reports what it read', () => {
    const reference = [
      '주방 수납, 아직도 이렇게 하고 있나요?',
      '1. 먼저 비우기',
      '2. 매일 쓰는 것만 꺼내두기',
      '3. 칸마다 한 종류만',
      '저장해두고 그대로 따라 해보세요. 친구에게도 공유해보세요.',
    ].join('\n');
    const analysis = analyzeReference(reference, 'instagram-reels');
    expect(analysis.hookAngle).toBe('problem-solve');
    expect(analysis.numberedSteps).toBe(3);
    expect(analysis.saveTriggers).toContain('저장');
    expect(analysis.shareTriggers.length).toBeGreaterThan(0);
    expect(analysis.advice.length).toBeGreaterThanOrEqual(3);

    const plan = planCrossChannel({
      topic: JEJU,
      variation: 0,
      reference: { text: reference, channel: 'instagram-reels' },
    });
    expect(plan.angle.id).toBe('problem-solve');
    expect(plan.reference?.numberedSteps).toBe(3);
    expect(plan.notes.join(' ')).toContain('레퍼런스 분석');
    expect(plan.appliedPatterns).toHaveLength(4);
  });

  it('ships structural patterns for every channel it plans for', () => {
    expect(PATTERN_LIBRARY.map((pattern) => pattern.channel)).toEqual([
      'instagram-reels',
      'youtube-shorts',
      'youtube-longform',
      'naver-blog',
      'tistory',
      'wordpress',
    ]);
    for (const pattern of PATTERN_LIBRARY) {
      expect(pattern.segments.length).toBeGreaterThanOrEqual(4);
      const share = pattern.segments.reduce((sum, segment) => sum + segment.sharePct, 0);
      expect(Math.abs(share - 100)).toBeLessThanOrEqual(1);
      expect(pattern.source.length).toBeGreaterThan(20);
    }
  });

  it('exports a Markdown plan a writer can paste', () => {
    const markdown = planToMarkdown(planCrossChannel({ topic: JEJU, variation: 1 }));
    expect(markdown).toContain('# 겨울 제주 여행 2박3일 코스');
    expect(markdown).toContain('## 1. 숏폼 대본');
    expect(markdown).toContain('## 2. 유튜브 롱폼 목차');
    expect(markdown).toContain('## 3. 블로그 뼈대');
    expect(markdown).toContain('## 4. 리퍼포징 맵');
  });
});

describe('LLM pass', () => {
  const base = planCrossChannel({ topic: JEJU, variation: 0 });

  it('rejects a payload with nothing usable', () => {
    expect(sanitizePayload(null)).toBeNull();
    expect(sanitizePayload({ hello: 'world' })).toBeNull();
    expect(sanitizePayload({ shorts: { scenes: [] } })).toBeNull();
  });

  it('keeps the offline plan when no key is configured', async () => {
    const result = await planWithClaude({ topic: JEJU }, { apiKey: '' });
    expect(result.plan).toBeNull();
    expect(result.error).toContain('ANTHROPIC_API_KEY');
    expect(result.prompt).toContain('채널 패턴');
  });

  it('overlays a valid Claude response on the pattern plan', async () => {
    const body = {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            shorts: {
              scenes: base.shorts.scenes.map((scene, index) => ({
                narration: `${scene.narration} (LLM ${index + 1})`,
                onScreenText: scene.onScreenText,
                beat: scene.beat,
              })),
              caption: 'LLM 캡션',
              hashtags: ['#제주', '#겨울여행'],
            },
            longform: {
              title: 'LLM 롱폼 제목',
              chapters: base.longform.chapters.map((chapter, index) => ({
                title: `LLM 챕터 ${index + 1}`,
                purpose: chapter.purpose,
                bullets: chapter.bullets,
              })),
            },
            blog: {
              title: 'LLM 블로그 제목',
              metaDescription: 'LLM 메타',
              intro: 'LLM 도입',
              sections: base.blog.outline.map((section, index) => ({
                heading: `LLM H2 ${index + 1}`,
                points: section.points,
              })),
              faq: [{ question: 'Q?', answer: 'A.' }],
              closing: 'LLM 마무리',
              keywords: ['제주 여행'],
            },
          }),
        },
      ],
      usage: { input_tokens: 1200, output_tokens: 800 },
    };
    const fetchImpl: FetchLike = async () => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });

    const result = await planWithClaude({ topic: JEJU }, { apiKey: 'test-key', fetchImpl, model: 'claude-test' });
    expect(result.error).toBeNull();
    expect(result.plan?.engine).toBe('claude');
    expect(result.plan?.engineDetail).toContain('claude-test');
    expect(result.plan?.shorts.scenes[0]?.narration).toContain('(LLM 1)');
    expect(result.plan?.longform.title).toBe('LLM 롱폼 제목');
    expect(result.plan?.blog.titleCandidates[0]).toBe('LLM 블로그 제목');
    expect(result.plan?.repurpose).toHaveLength(base.shorts.scenes.length);
    expect(result.usage?.outputTokens).toBe(800);
  });

  it('keeps the offline plan when the call fails', async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error('network down');
    };
    const result = await planWithClaude({ topic: JEJU }, { apiKey: 'test-key', fetchImpl });
    expect(result.plan).toBeNull();
    expect(result.error).toContain('Claude 호출 실패');
  });

  it('builds an explicit prompt with the angle and channel structures', () => {
    const prompt = buildPlannerPrompt(base);
    expect(prompt).toContain(base.angle.label);
    expect(prompt).toContain('인스타그램 릴스');
    expect(prompt).toContain('"shorts"');
  });

  it('does not mutate the base plan when a payload is applied', () => {
    const merged = applyLlmPlan(base, { shorts: { caption: '다른 캡션' } }, 'claude-test');
    expect(base.shorts.caption).not.toBe('다른 캡션');
    expect(merged.shorts.caption).toBe('다른 캡션');
  });
});

describe('studio drafts', () => {
  it('produces a fresh, topic-specific draft for each variation', () => {
    const sentences = new Set<string>();
    for (let variation = 0; variation < 5; variation += 1) {
      const drafts = writeTopicDrafts({ topic: MASSAGER, variation, durationSec: 45 }).drafts;
      expect(drafts[0]?.beat).toBe('hook');
      expect(drafts.at(-1)?.beat).toBe('cta');
      expect(drafts.map((draft) => draft.narration).join(' ')).toMatch(/마사지기|소음|무게|충전|사용/);
      sentences.add(drafts[0]?.narration ?? '');
    }
    expect(sentences.size).toBe(5);
  });
});
