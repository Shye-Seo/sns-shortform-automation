import { describe, expect, it } from 'vitest';
import { estimateSpeechSeconds } from '../src/lib/text';
import { applyVoice, findBanned, normalizeIdentity, renderVoiceDoc } from '../src/services/sonder/identity';
import { analyzeReference } from '../src/services/sonder/reference';
import { buildPlan, buildPlanPrompt, fitHook, readModelPlanPayload, renderPlanDoc, shortCaption } from '../src/services/sonder/planner';
import { summarizeLogs } from '../src/services/sonder/performance';
import { IDENTITY_PRESETS } from '../src/services/sonder/identity';
import type { ChannelIdentity, PerformanceLog } from '../src/services/sonder/types';

const TRANSCRIPT = `3평 주방에서 매번 냄비를 꺼내다 부딪혔습니다.
수납장 문 안쪽 10cm를 그냥 버리고 있었거든요.
문 안쪽에 얇은 선반을 달고, 냄비 뚜껑은 같은 크기끼리 묶었습니다.
그다음 용기 높이를 맞춰서 세로로 세웠어요.
한 달 써보니 꺼내는 시간이 3초에서 1초로 줄었습니다.
오늘은 한 칸만 비워보세요. 저장해두고 천천히 해보세요.`;

const identity = IDENTITY_PRESETS[0] as ChannelIdentity;
const structure = analyzeReference({ title: '3평 주방 수납', transcript: TRANSCRIPT, durationSec: 32 }).structure;
const topic = '부산 신혼집 3평 주방 수납 정리법';

const plan = () =>
  buildPlan({ topic, identity, structure, trendTitle: '3평 주방 수납', durationSec: 32 }).plan;

function log(overrides: Partial<PerformanceLog>): PerformanceLog {
  return {
    id: `log_${Math.random().toString(36).slice(2, 8)}`,
    planId: null,
    title: '영상',
    hookPattern: 'question',
    postedAt: '2026-11-20',
    views: 10000,
    saves: 100,
    shares: 10,
    follows: 1,
    medianViews: 5000,
    multiplier: 2,
    createdAt: '2026-11-20T00:00:00.000Z',
    ...overrides,
  };
}

describe('채널 정체성', () => {
  it('빈 이름은 저장하지 않는다', () => {
    expect(() => normalizeIdentity({ name: '  ' })).toThrow(/이름/);
  });

  it('쉼표로 들어온 목록을 정리한다', () => {
    const next = normalizeIdentity({ id: 'x', name: '테스트', strengths: ['  실측  ', ''], banned: ['완벽'] });
    expect(next.strengths).toEqual(['실측']);
    expect(next.banned).toEqual(['완벽']);
    expect(next.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('금지 표현은 대본에 실제로 들어간 것만 찾는다', () => {
    expect(findBanned('완벽한 정리는 없습니다', ['완벽', '무조건'])).toEqual(['완벽']);
    expect(findBanned('정리했습니다', ['완벽'])).toEqual([]);
  });

  it('상투어는 뜻이 통하는 말로 바꾼다', () => {
    expect(applyVoice('무조건 완벽한 인생템')).toBe('대부분 쓸 만한 오래 쓴 물건');
  });

  it('voice.md는 타깃·말투·금지 표현을 담는다', () => {
    const doc = renderVoiceDoc(identity);
    expect(doc).toContain('# 일상·리빙 (@shye__s)');
    expect(doc).toContain('## 말투');
    expect(doc).toContain('- 완벽');
  });
});

describe('기획안', () => {
  it('후킹 3안은 서로 다른 문장이고 3초 안쪽으로 다듬어진다', () => {
    const result = buildPlan({ topic, identity, structure, durationSec: 32 });
    expect(result.plan.hooks).toHaveLength(3);
    const texts = result.plan.hooks.map((hook) => hook.text);
    expect(new Set(texts).size).toBe(3);
    for (const hook of result.plan.hooks) {
      expect(hook.text.length).toBeGreaterThan(4);
      expect(estimateSpeechSeconds(hook.text, { language: 'ko', speed: 1 })).toBeLessThanOrEqual(3.6);
    }
  });

  it('첫 안은 빌려온 구조의 앵글로 열고 그 사실을 근거로 남긴다', () => {
    const result = buildPlan({ topic, identity, structure, durationSec: 32 });
    expect(result.plan.hooks[0]?.reason).toContain('빌려온 영상의 첫 문장');
    expect(result.plan.hooks[0]?.reason).toContain('숫자형');
  });

  it('빌린 영상의 마무리 요구를 그대로 목표로 삼는다', () => {
    expect(structure.goal).toBe('save');
    expect(plan().goal).toBe('save');
    const commentPlan = buildPlan({ topic, identity, structure: { ...structure, goal: 'comment' }, goal: 'comment' }).plan;
    expect(commentPlan.goal).toBe('comment');
  });

  it('장면은 시간이 겹치지 않고 목표 길이를 넘지 않는다', () => {
    const next = plan();
    expect(next.scenes.length).toBeGreaterThanOrEqual(4);
    expect(next.scenes[0]?.beat).toBe('hook');
    expect(next.scenes[next.scenes.length - 1]?.beat).toBe('cta');
    for (let index = 1; index < next.scenes.length; index += 1) {
      const previous = next.scenes[index - 1];
      const current = next.scenes[index];
      expect(current?.startSec).toBeCloseTo(previous?.endSec ?? 0, 5);
    }
    expect(next.checks.totalSec).toBeLessThanOrEqual(32.5);
    expect(next.checks.hookSec).toBeLessThanOrEqual(3.6);
  });

  it('선택한 훅이 첫 장면 내레이션이 된다', () => {
    const first = buildPlan({ topic, identity, structure, durationSec: 32 });
    const second = buildPlan({ topic, identity, structure, durationSec: 32, chosenHook: 'B' });
    expect(second.plan.chosenHook).toBe('B');
    expect(second.plan.scenes[0]?.narration).toBe(second.plan.hooks[1]?.text);
    expect(second.plan.scenes[0]?.narration).not.toBe(first.plan.scenes[0]?.narration);
  });

  it('금지 표현이 들어가면 점검에 남는다', () => {
    const strict: ChannelIdentity = { ...identity, banned: ['주방'] };
    const next = buildPlan({ topic, identity: strict, structure, durationSec: 32 }).plan;
    expect(next.checks.bannedHits).toContain('주방');
  });

  it('캡션은 훅·본문·요구·시그니처·해시태그를 담는다', () => {
    const next = plan();
    expect(next.caption).toContain(next.hooks[0]?.text ?? '');
    expect(next.caption).toContain('저장해두세요');
    expect(next.caption).toContain(identity.signature[0] as string);
    expect(next.hashtags.length).toBeGreaterThan(2);
    expect(next.caption.length).toBeLessThanOrEqual(2200);
  });

  it('박자표는 빌린 구조와 이 기획안을 나란히 놓는다', () => {
    const next = plan();
    expect(next.beatTable.map((row) => row.beat)).toEqual(['hook', 'problem', 'solution', 'cta']);
    const total = next.beatTable.reduce((sum, row) => sum + row.planSec, 0);
    expect(total).toBeCloseTo(next.checks.totalSec, 0);
    expect(next.beatTable.find((row) => row.beat === 'hook')?.borrowedSec).toBeCloseTo(5, 0);
  });

  it('성과 로그가 있으면 저장률이 높은 훅을 추천한다', () => {
    const logs = [
      log({ hookPattern: 'contrarian', saves: 900, views: 10000 }),
      log({ hookPattern: 'contrarian', saves: 700, views: 10000 }),
      log({ hookPattern: 'numbers', saves: 50, views: 10000 }),
    ];
    const result = buildPlan({ topic, identity, structure, durationSec: 32, feedback: summarizeLogs(logs) });
    const recommended = result.plan.hooks.find((hook) => hook.id === result.recommended);
    expect(recommended?.pattern).toBe('contrarian');
    expect(result.recommended).not.toBe('A');
  });

  it('주제가 너무 짧으면 만들지 않는다', () => {
    expect(() => buildPlan({ topic: ' ', identity, structure })).toThrow(/주제/);
  });

  it('기획안 문서로 내보낼 수 있다', () => {
    const doc = renderPlanDoc(plan());
    expect(doc).toContain('# 부산 신혼집 3평 주방 수납 정리법');
    expect(doc).toContain('## 컷별 자막');
    expect(doc).toContain('## 캡션');
  });

  it('화면 자막은 24자에서 끊는다', () => {
    expect(shortCaption('주방 수납, 세 칸만 비우면 됩니다')).toBe('주방 수납, 세 칸만 비우면 됩니다');
    expect(shortCaption('아주 긴 문장이 들어오면 화면 자막은 여기서 끊깁니다 정말로').length).toBeLessThanOrEqual(24);
  });

  it('훅이 3초를 넘으면 앞부분만 남긴다', () => {
    const long = '수납용품을 사기 전에 먼저 우리 집 주방의 동선을 확인하고 그다음에 무엇을 살지 정해야 합니다';
    const fitted = fitHook(long);
    expect(estimateSpeechSeconds(fitted, { language: 'ko', speed: 1 })).toBeLessThanOrEqual(3.6);
    expect(fitted.length).toBeLessThan(long.length);
  });
});

describe('모델 응답 처리', () => {
  it('지시문에 채널 말투·금지 표현·빌린 박자가 들어간다', () => {
    const prompt = buildPlanPrompt({ topic, identity, structure, durationSec: 32 });
    expect(prompt.user).toContain(identity.voice);
    expect(prompt.user).toContain(identity.banned[0] as string);
    expect(prompt.user).toContain('숫자형');
    expect(prompt.user).toContain('32초');
    expect(prompt.system).toContain('JSON');
  });

  it('모델 응답에서 훅과 장면만 꺼내고, 모양이 다르면 null을 돌려준다', () => {
    const parsed = readModelPlanPayload({
      hooks: [{ pattern: 'question', text: '주방 수납, 왜 막힐까요?' }, '두 번째 안'],
      scenes: [{ beat: 'hook', narration: '첫 문장' }, { beat: 'cta', narration: '' }],
    });
    expect(parsed?.hooks).toHaveLength(2);
    expect(parsed?.scenes).toHaveLength(1);
    expect(readModelPlanPayload({ hooks: [] })).toBeNull();
    expect(readModelPlanPayload('nope')).toBeNull();
  });
});
