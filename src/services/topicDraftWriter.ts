import { stableHash } from '../lib/ids';
import { estimateSpeechSeconds } from '../lib/text';
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

/**
 * Hook candidates per angle, ordered long → short. A long topic plus a long
 * predicate overruns the 3.5s hook ceiling and the fitter then trims words until
 * the sentence loses its verb ("팔꿈치 마사지기," alone). So the writer measures
 * every candidate and uses the first one that fits, rotating among the fitting
 * ones for variety. The compact forms at the end are real hooks, not leftovers.
 */
const HOOK_TEMPLATES: Record<AngleId, string[]> = {
  'problem-solve': ['{h}, {d}부터 보세요', '{h}, 왜 {d}에서 막힐까요?', '{h}, 답은 {d}', '{d}에서 막히나요?'],
  numbers: ['{h}, 3가지만 기억하세요', '{h}, 3분이면 됩니다', '9명이 놓치는 {d}'],
  checklist: ['{h}, 이 순서만 지키세요', '{h}, 확인할 4가지', '{h}, 순서 틀리면 다시', '확인할 4가지'],
  'before-after': ['{h}, 전후가 다릅니다', '{h}, 3주 뒤 달라집니다', '전후가 다릅니다'],
  contrarian: ['{h}, {b}부터 버리세요', '{b}부터 버리세요', '{h}, {b}{bi} 답이 아닙니다', '{b}{bi} 안 통합니다'],
};

/**
 * CTAs stay short on purpose: the CTA scene is never compressed (it is the one
 * beat the fitter must not shorten), so a long subject inside it pushes the
 * whole timeline over budget. The topic already lives in the hook and steps.
 */
const CTA_TEMPLATES: Record<CtaGoal, string[]> = {
  save: ['다시 볼 때를 위해 저장해두세요.', '지금 저장해두면 다음에 안 헤맵니다.', '순서 그대로 저장해두세요.'],
  comment: ['어디서 막히는지 댓글로 알려주세요.', '써봤으면 댓글에 남겨주세요.'],
  follow: ['시리즈 계속 올립니다. 팔로우해두세요.', '다음 편에서 마무리합니다.'],
  link: ['자세한 순서는 프로필 링크에 있습니다.', '체크리스트는 프로필 링크에서 받아가세요.'],
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

// The fitter's hook cap is 3.25s at 45s; leave a margin so a borderline line
// is not clause-trimmed down to its subject after the fact.
const HOOK_BUDGET_SEC = 3.0;

function hookSubjectFor(profile: TopicProfile): string {
  const subject = profile.subject.trim();
  if (subject.length <= 8) return subject;
  const tail = subject.split(' ').slice(-2).join(' ');
  return tail.length <= 10 ? tail : profile.core;
}

function chooseHook(
  angle: AngleId,
  profile: TopicProfile,
  belief: string,
  hookSubject: string,
  variation: number,
): string {
  const filled = HOOK_TEMPLATES[angle].map((template) => fill(template, profile, belief, hookSubject));
  const fits = (line: string): boolean =>
    estimateSpeechSeconds(line, { language: 'ko', speed: 1 }) <= HOOK_BUDGET_SEC;
  const topical = filled.filter(
    (line) => line.includes(hookSubject) || line.includes(profile.detail) || line.includes(profile.core),
  );
  // Prefer a hook that names the topic; subject-free forms exist only as a last
  // resort for very long topics where nothing topical fits in 3 seconds.
  const pool = topical.filter(fits);
  const fallback = filled.filter(fits);
  const chosen = pool.length > 0 ? pool : fallback.length > 0 ? fallback : [filled.reduce((a, b) => (a.length <= b.length ? a : b))];
  return pickAt(chosen, variation);
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

function fill(template: string, profile: TopicProfile, belief: string, hookSubject = profile.subject): string {
  return template
    .replace(/\{h\}/g, hookSubject)
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
  // Hooks use a shorter subject so the line stays inside the 3.5s ceiling while
  // still naming the topic: "부산 신혼집 3평 주방 수납" → "주방 수납".
  const hook = chooseHook(angle.id, profile, belief, hookSubjectFor(profile), variation);
  // Keep the topic in the body too: prefer a problem line that names it, so a
  // shortened hook never leaves the script without the subject.
  const problemLines = bank.problems.map((line) => fill(line, profile, belief, hookSubjectFor(profile)));
  const topicalProblems = problemLines.filter(
    (line) => line.includes(profile.core) || line.includes(profile.subject),
  );
  const problem = pickAt(topicalProblems.length > 0 ? topicalProblems : problemLines, hash + variation);
  // Fill the chosen length with steps instead of leaving a third of the
  // timeline empty: 30s → 2 steps, 45s → 4, 60s → 4 (bank size ceiling).
  const stepCount = Math.min(4, Math.max(2, Math.round((durationSec - 15) / 7.5)));
  const start = variation % Math.max(1, bank.steps.length - stepCount + 1);
  const steps = bank.steps.slice(start, start + stepCount);
  const cta = pickAt(CTA_TEMPLATES[ctaGoal], hash + variation);

  const visual = CATEGORY_VISUAL[profile.category];
  const screens = bank.screens;
  const angleIndex = ANGLE_LIST.findIndex((entry) => entry.id === angle.id);

  const drafts: SceneDraft[] = [
    {
      beat: 'hook',
      narration: (() => {
        const line = fill(hook, profile, belief, hookSubjectFor(profile));
        return /[.?!]$/.test(line) ? line : `${line}.`;
      })(),
      onScreenText: fill(pickAt(screens.hook, angleIndex + hash + variation), profile, belief),
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

/** Human label for the console: "숫자비교형 · 변주 4". */
export function describeAngle(angle: Angle, variation: number): string {
  return `${angle.label} · 변주 ${variation + 1}`;
}
