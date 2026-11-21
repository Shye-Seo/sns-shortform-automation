import { estimateSpeechSeconds } from '../lib/text';
import type { AngleChoice, Angle, AngleId, TopicProfile } from '../types/plan';
import type { CtaGoal, HookType } from '../types/script';
import type { SceneDraft } from './scriptEngine';
import { classifyTopic } from './topicProfile';
import { resolveDomainAngle, writeDomainDrafts, type DomainDraftResult } from './domainScriptWriter';
import { classifyScriptDomain, type ScriptDomainProfile } from './scriptDomains';

/**
 * 주제 → 4비트 대본.
 *
 * 2026-11-21 개편: 문장을 카테고리 은행 하나에서 고르던 방식을 버리고,
 * `scriptDomains`의 도메인 분류 + 도메인별 문장 은행(`domainScriptWriter`)으로
 * 넘긴다. 이 파일은 기존 호출부(스튜디오·기획기·OSMU·훅 비교)가 기대하는
 * 반환 형태를 유지하는 얇은 어댑터다.
 *
 * 왜 분류를 두 단계로 두는가:
 *  - `topicProfile`은 "무엇에 대한 영상인가"(여행·제품·정보…)를 정하고 블로그·롱폼
 *    구조에 쓰인다. 기존 테스트가 이 분류를 고정하고 있다.
 *  - `scriptDomains`는 "어떤 말로 말하는가"(일상 기록·커리어·카페…)를 정한다.
 *    "퇴사한 30대 개발자의 일상"은 소재가 커리어지만 형식은 일상 기록이라,
 *    두 축을 분리해야 글이 어색해지지 않는다.
 */

/** CLI --hook 값은 콘솔이 도는 다섯 앵글에 그대로 대응한다. */
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

export function resolveAngle(choice: AngleChoice | undefined, topic: string, variation: number): Angle {
  return resolveDomainAngle(choice, topic, variation);
}

export function badgeFor(profile: TopicProfile): string {
  const candidate = profile.subject.replace(/\s+/g, ' ').trim();
  if (candidate.length <= 14) return candidate;
  const parts = candidate.split(' ');
  const tail = parts.slice(-2).join(' ');
  return (tail.length <= 14 ? tail : (parts[parts.length - 1] ?? candidate)).slice(0, 14);
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
  /** Pre-classified script domain, when the caller already has one. */
  domainProfile?: ScriptDomainProfile;
}

export interface TopicDraftResult {
  profile: TopicProfile;
  /** 말투·소재 도메인("일상·브이로그"). 콘솔이 분류 근거를 함께 보여준다. */
  scriptDomain: ScriptDomainProfile;
  angle: Angle;
  variation: number;
  drafts: SceneDraft[];
  hook: string;
  cta: string;
  caption: string;
  hashtags: string[];
}

export function writeTopicDrafts(input: TopicDraftInput): TopicDraftResult {
  const profile = input.profile ?? classifyTopic(input.topic);
  const domainProfile = input.domainProfile ?? classifyScriptDomain(input.topic);
  const written: DomainDraftResult = writeDomainDrafts({
    topic: input.topic,
    durationSec: input.durationSec,
    variation: input.variation,
    angle: input.angle,
    ctaGoal: input.ctaGoal,
    profile,
    domainProfile,
  });

  return {
    profile,
    scriptDomain: written.domain,
    angle: written.angle,
    variation: written.variation,
    drafts: written.drafts,
    hook: written.hook,
    cta: written.cta,
    caption: written.caption,
    hashtags: written.hashtags,
  };
}

/** Human label for the console: "숫자비교형 · 변주 4". */
export function describeAngle(angle: Angle, variation: number): string {
  return `${angle.label} · 변주 ${variation + 1}`;
}

/** 훅 후보의 길이를 콘솔에서 확인할 때 쓰는 값. */
export function hookSeconds(hook: string): number {
  return estimateSpeechSeconds(hook, { language: 'ko', speed: 1 });
}

