import { stableHash } from '../lib/ids';
import type { AngleId, AngleChoice, Angle, TopicCategory, TopicProfile } from '../types/plan';
import type { CtaGoal, HookType } from '../types/script';
import type { SceneDraft } from './scriptEngine';
import { ANGLE_BY_ID, ANGLE_LIST } from './patternLibrary';
import { TOPIC_BANKS } from './topicBanks';
import { classifyTopic } from './topicProfile';

/**
 * Topic-aware shortform writer.
 *
 * Three inputs decide every line: the topic profile (what the topic is about),
 * the angle (the shape of the argument) and the variation counter (which of the
 * interchangeable phrasings is used this time). Regeneration bumps the counter,
 * which rotates the angle every five presses and rotates the phrasing on every
 * press, so two presses can never return the same captions while the topic
 * stays fixed.
 */

const CATEGORY_BELIEF: Record<TopicCategory, string> = {
  travel: '일정 꽉 채우기',
  product: '비싼 게 좋은 것',
  info: '금액부터 보기',
  recipe: '재료 많이 넣기',
  home: '수납용품 사기',
  beauty: '비싼 화장품',
  money: '수익률 높이기',
  care: '강도 높은 운동',
  work: '길게 쓰기',
  daily: '크게 바꾸기',
};

const CATEGORY_VISUAL: Record<TopicCategory, string[]> = {
  travel: ['이동 장면 B롤 + 지도 오버레이', '숙소 도착 컷, 짐 내리는 손', '첫날 코스 지도에 선 긋기', '터미널 시계 클로즈업'],
  product: ['제품 개봉 클로즈업', '실사용 장면, 손과 제품', '소음 측정 앱 화면', '반품 박스에 다시 담는 컷'],
  info: ['공고 화면 캡처, 조건 형광펜', '서류 표 정리 장면', '계산기 화면', '공식 사이트 스크롤'],
  recipe: ['재료 늘어놓은 오버헤드', '타이머 30초 카운트', '접시에 담는 마무리', '남은 재료 용기 담기'],
  home: ['비포/애프터 분할 화면', '칸 비우는 손', '라벨 붙이는 클로즈업', '바닥 비운 뒤 와이드'],
  beauty: ['자연광 얼굴 클로즈업', '손등 발색 비교', '얇게 두 번 바르는 컷', '같은 조명 재촬영'],
  money: ['가계부 표 화면', '자동이체 설정 화면', '영수증 정리 컷', '잔액 확인 클로즈업'],
  care: ['자세 측면 촬영', '10분 타이머', '거울로 자세 체크', '쉬는 날 스트레칭'],
  work: ['문서 첫 문장 강조', '링크 하나로 정리된 화면', '숫자 넣은 표', '소리 내어 읽는 컷'],
  daily: ['핸드헬드 일상 컷', '손이 먼저 움직이는 장면', '하루 순서 타임랩스', '메모 적는 손'],
};

const HOOK_TEMPLATES: Record<AngleId, string[]> = {
  'problem-solve': [
    '{s}, {d}부터 바꾸면 달라집니다',
    '{s}, 왜 매번 {d}에서 막힐까요?',
    '{s}, 결론부터 말하면 {d}입니다',
  ],
  numbers: ['{s}, 딱 3가지만 기억하세요', '{s}, 10명 중 9명이 놓치는 {d}', '{s}, 3분이면 정리됩니다'],
  checklist: ['{s} 체크리스트, 순서대로만 하세요', '{s} 하기 전에 꼭 확인할 4가지', '{s}, 이 순서 아니면 다시 합니다'],
  'before-after': ['{s}, 하기 전과 후가 이렇게 다릅니다', '{s} 하고 나서 제일 달라진 것', '{s}, 3주 뒤 이렇게 됩니다'],
  contrarian: ['{s}, {b}{bi} 답이 아닙니다', '{s}, {b}부터 버리세요', '{b}{bi} {s}에서는 안 통합니다'],
};

const CTA_TEMPLATES: Record<CtaGoal, string[]> = {
  save: ['{s} 다시 볼 때를 위해 저장해두세요.', '지금 저장해두면 다음에 안 헤맵니다.', '순서 그대로 저장해두세요.'],
  comment: ['{s}, 어디서 막히는지 댓글로 알려주세요.', '이 방법 써봤으면 댓글에 남겨주세요.'],
  follow: ['{s} 시리즈 계속 올립니다. 팔로우해두세요.', '다음 편은 {s} 마무리입니다.'],
  link: ['자세한 순서는 프로필 링크의 {s} 정리에 있습니다.', '체크리스트는 프로필 링크에서 받아가세요.'],
};

const ANGLE_CTA_EXTRA: Record<AngleId, string> = {
  'problem-solve': '막히는 지점부터 다시 보세요.',
  numbers: '숫자만 바꿔서 한 번 더 해보세요.',
  checklist: '체크리스트처럼 하나씩 확인하세요.',
  'before-after': '전후 사진을 나란히 놓고 보세요.',
  contrarian: '반대라고 생각하면 댓글로 알려주세요.',
};

/** CLI --hook values map onto the same five angles the console cycles. */
export function angleForHookType(hookType: HookType): AngleId {
  switch (hookType) {
    case 'numbers':
      return 'numbers';
    case 'howto':
      return 'checklist';
    case 'contrarian':
      return 'contrarian';
    case 'shock':
      return 'before-after';
    default:
      return 'problem-solve';
  }
}

function hashOf(text: string): number {
  return parseInt(stableHash(text), 16);
}

export function resolveAngle(choice: AngleChoice | undefined, topic: string, variation: number): Angle {
  if (choice && choice !== 'auto') return ANGLE_BY_ID[choice];
  const index = (hashOf(topic) + Math.max(0, variation)) % ANGLE_LIST.length;
  return ANGLE_LIST[index] as Angle;
}

export function badgeFor(profile: TopicProfile): string {
  const candidate = profile.subject.replace(/\s+/g, ' ').trim();
  if (candidate.length <= 14) return candidate;
  const parts = candidate.split(' ');
  const tail = parts.slice(-2).join(' ');
  return (tail.length <= 14 ? tail : (parts[parts.length - 1] ?? candidate)).slice(0, 14);
}

function hasBatchim(word: string): boolean {
  const last = Array.from(word.trim()).pop();
  if (!last) return false;
  const code = last.charCodeAt(0);
  if (code < 0xac00 || code > 0xd7a3) return false;
  return (code - 0xac00) % 28 !== 0;
}

function fill(template: string, profile: TopicProfile, belief: string): string {
  return template
    .replace(/\{s\}/g, profile.subject)
    .replace(/\{d\}/g, profile.detail)
    .replace(/\{b\}/g, belief)
    .replace(/\{bi\}/g, hasBatchim(belief) ? '이' : '가')
    .replace(/\{badge\}/g, badgeFor(profile));
}

function pickAt<T>(items: T[], index: number): T {
  return items[((index % items.length) + items.length) % items.length] as T;
}

export interface TopicDraftInput {
  topic: string;
  durationSec?: number;
  variation?: number;
  angle?: AngleChoice;
  ctaGoal?: CtaGoal;
  language?: 'ko' | 'en';
  /** Pre-classified profile, when the planner already has one. */
  profile?: TopicProfile;
}

export interface TopicDraftResult {
  profile: TopicProfile;
  angle: Angle;
  variation: number;
  drafts: SceneDraft[];
  hook: string;
  cta: string;
  caption: string;
  hashtags: string[];
}

const HASHTAG_SUFFIX: Record<TopicCategory, string[]> = {
  travel: ['#여행', '#주말여행', '#여행코스'],
  product: ['#내돈내산', '#제품리뷰', '#가성비'],
  info: ['#정보정리', '#신청방법', '#조건확인'],
  recipe: ['#간단레시피', '#집밥', '#자취요리'],
  home: ['#수납정리', '#신혼집', '#살림'],
  beauty: ['#뷰티', '#색조추천', '#화장품리뷰'],
  money: ['#재테크', '#가계부', '#절약'],
  care: ['#운동루틴', '#자세교정', '#홈트'],
  work: ['#커리어', '#포트폴리오', '#생산성'],
  daily: ['#일상', '#루틴', '#브이로그'],
};

export function writeTopicDrafts(input: TopicDraftInput): TopicDraftResult {
  const variation = Math.max(0, Math.round(input.variation ?? 0));
  const durationSec = Math.min(60, Math.max(10, input.durationSec ?? 45));
  const ctaGoal: CtaGoal = input.ctaGoal ?? 'save';
  const profile = input.profile ?? classifyTopic(input.topic);
  const angle = resolveAngle(input.angle, profile.topic, variation);
  const bank = TOPIC_BANKS[profile.category];
  const belief = CATEGORY_BELIEF[profile.category];
  const subject = profile.subject;
  const hash = hashOf(profile.topic);

  // Angle rotates every five presses; the phrasing inside the angle rotates on
  // every press, so consecutive presses never repeat the hook.
  const hook = pickAt(HOOK_TEMPLATES[angle.id], hash + Math.floor(variation / 5));
  const problem = pickAt(bank.problems, hash + variation);
  const stepCount = Math.min(4, Math.max(2, Math.round(durationSec / 16)));
  const start = variation % Math.max(1, bank.steps.length - stepCount + 1);
  const steps = bank.steps.slice(start, start + stepCount);
  const cta = variantCta(ctaGoal, angle.id, profile, variation);

  const visual = CATEGORY_VISUAL[profile.category];
  const screens = bank.screens;

  const drafts: SceneDraft[] = [
    {
      beat: 'hook',
      narration: `${fill(hook, profile, belief)}.`,
      onScreenText: fill(pickAt(screens.hook, hash + variation), profile, belief),
      emphasis: [profile.core],
      visual: visual[0],
    },
    {
      beat: 'problem',
      narration: fill(problem, profile, belief),
      onScreenText: fill(pickAt(screens.problem, hash + variation + 1), profile, belief),
      emphasis: [profile.core],
      visual: visual[1] ?? visual[0],
    },
    ...steps.map((step, index) => ({
      beat: 'solution' as const,
      narration: fill(step, profile, belief),
      onScreenText: fill(pickAt(screens.step, index + hash), profile, belief),
      emphasis: [profile.core],
      visual: visual[Math.min(visual.length - 1, 2 + (index % 2))],
    })),
    {
      beat: 'cta',
      narration: cta,
      onScreenText: fill(pickAt(screens.cta, hash + variation), profile, belief),
      emphasis: [],
      visual: visual[visual.length - 1] ?? visual[0],
    },
  ];

  const hookLine = drafts[0]?.narration ?? '';
  const caption = [
    hookLine,
    `${subject}에서 실제로 막히는 건 ${profile.detail}입니다. 순서만 바꿔도 체감이 달라집니다.`,
    ctaGoal === 'comment' ? '어디서 막히는지 댓글로 알려주세요.' : '필요할 때 다시 보려면 저장해두세요.',
  ].join('\n');

  const primaryTag =
    subject
      .split(/\s+/)
      .map((token) => token.replace(/[^가-힣A-Za-z0-9]/g, ''))
      .find((token) => token.length >= 2 && !/^\d/.test(token) && !/^(겨울|봄|여름|가을)$/.test(token)) ?? profile.core;

  const hashtags = Array.from(
    new Set([`#${primaryTag}`, ...HASHTAG_SUFFIX[profile.category], '#숏폼'].filter((tag) => tag.length > 1)),
  ).slice(0, 8);

  return { profile, angle, variation, drafts, hook: hookLine, cta, caption, hashtags };
}

function variantCta(goal: CtaGoal, angle: AngleId, profile: TopicProfile, variation: number): string {
  const base = pickAt(CTA_TEMPLATES[goal], variation).replace(/\{s\}/g, profile.subject);
  const extra = ANGLE_CTA_EXTRA[angle];
  return variation % 2 === 0 ? `${base} ${extra}` : base;
}

/** Human label for the console: "숫자비교형 · 변주 4". */
export function describeAngle(angle: Angle, variation: number): string {
  return `${angle.label} · 변주 ${variation + 1}`;
}
