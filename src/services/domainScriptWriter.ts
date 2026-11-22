import { stableHash } from '../lib/ids';
import { countSyllables, estimateSpeechSeconds, normalizeWhitespace } from '../lib/text';
import type { Angle, AngleChoice, AngleId, TopicProfile } from '../types/plan';
import type { CtaGoal } from '../types/script';
import type { SceneDraft } from './scriptEngine';
import { ANGLE_BY_ID, ANGLE_LIST } from './patternLibrary';
import {
  SCRIPT_DOMAIN_BANKS,
  SCRIPT_DOMAIN_META,
  SCRIPT_DOMAIN_TAGS,
  classifyScriptDomain,
  type ScriptDomainId,
  type ScriptDomainProfile,
} from './scriptDomains';

/**
 * 도메인별 4비트 대본 작성기.
 *
 * 2026-11-22 개편:
 *  - 도메인(말투) 위에 **지식 팩**을 얹는다. "전세사기"가 걸리면 해결 단계가
 *    등기부등본·전입신고·HUG 특약으로 바뀐다. 팩이 없으면 도메인 은행을 쓴다.
 *  - 훅도 팩이 있으면 팩의 훅을 먼저 쓴다. "데스크 조명, 높이부터 맞추세요"처럼
 *    도메인 기본 훅이 주제와 어긋나는 경우를 막는다.
 *
 * 지키는 것
 *  - 훅은 3.0초(약 16음절) 안에서 끝난다. 넘으면 렌더 단계에서 잘리므로 작성
 *    단계에서 고른다.
 *  - 주제 이름은 훅에서 한 번만 쓴다. 해결 단계에 다시 넣으면 기계적으로 반복된다.
 *  - 같은 문장을 두 번 넣지 않는다.
 */

const HOOK_BUDGET_SEC = 3.2;

/** 이름에서 뺐을 때 여전히 주제를 가리키는 꼬리말. 훅이 길어질 때만 쓴다. */
const DROPPABLE_TAIL = /\s+(조건|방법|정리|점검|추천|기록|일상|루틴|코스|리스트|후기|리뷰|가이드)$/u;

function hashOf(text: string): number {
  return parseInt(stableHash(text), 16);
}

function hasBatchim(word: string): boolean {
  const last = Array.from(word.trim()).pop();
  if (!last) return false;
  const code = last.charCodeAt(0);
  if (code < 0xac00 || code > 0xd7a3) return false;
  return (code - 0xac00) % 28 !== 0;
}

interface FillContext {
  name: string;
  place: string;
  detail: string;
  /** 사람 묘사("퇴사한 30대 개발자"). 없으면 ''. */
  persona: string;
}

/** {n은}처럼 조사가 붙은 슬롯은 받침을 보고 고른다. */
export function fillDomainTemplate(template: string, context: FillContext): string {
  const withParticle = (word: string, consonant: string, vowel: string): string =>
    `${word}${hasBatchim(word) ? consonant : vowel}`;
  const { name, place, detail } = context;
  return template
    .replace(/\{n은\}/g, withParticle(name, '은', '는'))
    .replace(/\{n이\}/g, withParticle(name, '이', '가'))
    .replace(/\{n을\}/g, withParticle(name, '을', '를'))
    .replace(/\{n과\}/g, withParticle(name, '과', '와'))
    .replace(/\{n도\}/g, withParticle(name, '도', '도'))
    .replace(/\{p은\}/g, withParticle(place || name, '은', '는'))
    .replace(/\{p도\}/g, withParticle(place || name, '도', '도'))
    .replace(/\{p\}/g, place || name)
    .replace(/\{d\}/g, detail)
    .replace(/\{persona\}/g, context.persona || name)
    .replace(/\{n\}/g, name);
}

function pickAt<T>(items: readonly T[], index: number): T {
  return items[((index % items.length) + items.length) % items.length] as T;
}

function ensureSentence(line: string): string {
  const trimmed = normalizeWhitespace(line);
  return /[.?!…]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/**
 * 훅·문제에 쓸 수 있는 사람 묘사인지 판단한다.
 * "개발자", "퇴사한 30대 개발자"는 되지만 "부산 전포"처럼 사람이 아닌 수식어는
 * 문장에 넣으면 어색해지므로 버린다.
 */
const PERSON_WORDS = /(개발자|디자이너|기획자|마케터|프리랜서|직장인|대학생|주부|취준생|창업자|강사|간호사|엄마|아빠|신혼|퇴사|이직|복귀|1인|자취|워킹맘)/u;

function usablePersona(persona: string): string {
  const trimmed = persona.trim();
  if (trimmed.length < 2 || trimmed.length > 14) return '';
  return PERSON_WORDS.test(trimmed) ? trimmed : '';
}

/** 주제 이름을 이루는 낱말(조사·일반어 제외). 문제 문장의 주제성 판단에 쓴다. */
export function referenceTerms(name: string): string[] {
  const generic = new Set(['기록', '일상', '방법', '정리', '추천', '리뷰', '후기', '루틴', '코스']);
  return name
    .split(/\s+/)
    .map((token) => token.replace(/[^\p{L}\p{N}]/gu, ''))
    .filter((token) => token.length >= 2 && !generic.has(token));
}

export function resolveDomainAngle(choice: AngleChoice | undefined, topic: string, variation: number): Angle {
  if (choice && choice !== 'auto') return ANGLE_BY_ID[choice];
  const index = (hashOf(topic) + Math.max(0, variation)) % ANGLE_LIST.length;
  return ANGLE_LIST[index] as Angle;
}

/**
 * 훅 고르기.
 *
 * 1순위는 주제의 전체 이름이다. 3.2초 안에 두 문장이 안 들어가면 이름을 한
 * 단계씩만 줄인다(꼬리말 제거 → 앞 두 낱말 → 뒤 두 낱말 → 마지막 낱말).
 * 이름을 줄이는 것보다 문장이 잘리는 게 더 나쁘고, "조건"처럼 너무 짧은
 * 이름을 처음부터 쓰는 것도 나쁘다. 그래서 "두 문장이 들어가는 가장 긴 이름"을 쓴다.
 */
function chooseDomainHook(
  domainId: ScriptDomainId,
  angle: AngleId,
  context: FillContext,
  variation: number,
  packHooks: readonly string[] = [],
): string {
  const bank = SCRIPT_DOMAIN_BANKS[domainId];
  // 훅은 마침표를 붙이지 않는다. 마침표 하나가 0.24초를 먹어서 상한을 넘긴다.
  const candidatesFor = (ctx: FillContext): string[] =>
    [...packHooks, ...bank.hooks[angle]].map((template) =>
      normalizeWhitespace(fillDomainTemplate(template, ctx)).replace(/\.$/u, ''),
    );
  const seconds = (line: string): number => estimateSpeechSeconds(line, { language: 'ko', speed: 1 });

  const tokens = context.name.split(/\s+/).filter(Boolean);
  const stripTailParticle = (text: string): string => text.replace(/(의|은|는|이|가|을|를)$/u, '').trim();
  const tiers = [
    context.name,
    context.place,
    tokens.slice(0, 2).join(' '),
    tokens.slice(-2).join(' '),
    tokens.at(-1) ?? context.name,
    stripTailParticle(context.name.replace(DROPPABLE_TAIL, '')),
  ].filter((name, index, all) => name.length >= 2 && all.indexOf(name) === index);

  let single: string | null = null;
  for (const name of tiers) {
    const filled = candidatesFor({ ...context, name });
    const fitting = filled.filter((line) => seconds(line) <= HOOK_BUDGET_SEC);
    if (fitting.length >= 2) return pickAt(fitting, variation);
    if (fitting.length === 1 && single === null) single = fitting[0] as string;
  }

  if (single !== null) return single;

  const fallback = candidatesFor({ ...context, name: tiers.at(-1) ?? context.name });
  return [...fallback].sort((a, b) => seconds(a) - seconds(b))[0] as string;
}

function stepCountFor(durationSec: number): number {
  if (durationSec >= 40) return 4;
  return 2;
}

export interface DomainDraftInput {
  topic: string;
  durationSec?: number;
  variation?: number;
  angle?: AngleChoice;
  ctaGoal?: CtaGoal;
  profile?: TopicProfile;
  /** 이미 분류한 도메인(기획기가 넘겨줄 때). */
  domainProfile?: ScriptDomainProfile;
}

export interface DomainDraftResult {
  domain: ScriptDomainProfile;
  angle: Angle;
  variation: number;
  drafts: SceneDraft[];
  hook: string;
  cta: string;
  caption: string;
  hashtags: string[];
}

/** 훅·문제에서 주제 이름이 몇 번 나오는지. 반복 상한을 검사할 때 쓴다. */
export function topicMentions(text: string, name: string): number {
  if (name.trim() === '') return 0;
  return text.split(name).length - 1;
}

export function writeDomainDrafts(input: DomainDraftInput): DomainDraftResult {
  const variation = Math.max(0, Math.round(input.variation ?? 0));
  const durationSec = Math.min(60, Math.max(10, input.durationSec ?? 45));
  const ctaGoal: CtaGoal = input.ctaGoal ?? 'save';
  const domain = input.domainProfile ?? classifyScriptDomain(input.topic);
  const angle = resolveDomainAngle(input.angle, domain.topic, variation);
  const bank = SCRIPT_DOMAIN_BANKS[domain.id];
  const pack = domain.knowledge?.pack ?? null;
  const context: FillContext = {
    name: domain.name,
    place: domain.place,
    detail: SCRIPT_DOMAIN_META[domain.id].detail,
    persona: usablePersona(domain.persona),
  };
  const hash = hashOf(domain.topic);

  const hook = chooseDomainHook(domain.id, angle.id, context, variation, pack?.hooks?.[angle.id] ?? []);

  // 사람 묘사가 없으면 그 슬롯이 들어간 문장은 후보에서 뺀다("도 처음엔…"만 남는 문장 방지).
  const problemCandidates = [...(pack?.problems ?? []), ...bank.problems]
    .filter((template) => !template.includes('{persona}') || context.persona !== '')
    .map((template) => ensureSentence(fillDomainTemplate(template, context)));
  // 문제 문장은 주제 이름 전체를 다시 읽지 않아도 된다. 이름을 이루는 말이 들어 있으면
  // 충분히 이 주제의 문장이고, "전세사기는 …"처럼 매번 반복하는 것보다 자연스럽다.
  const terms = referenceTerms(domain.name);
  const topical = problemCandidates.filter(
    (line) =>
      terms.some((term) => line.includes(term)) ||
      (domain.place !== '' && line.includes(domain.place)) ||
      (domain.knowledge?.matched ?? []).some((word) => line.includes(word)),
  );
  const problemPool = topical.length > 0 ? topical : problemCandidates;
  const problem = pickAt(problemPool, hash + variation);

  const stepTemplates = pack && pack.steps.length >= 3 ? pack.steps : bank.steps;
  const maxCount = Math.min(stepCountFor(durationSec), stepTemplates.length);
  // 45초 대본은 4단계가 기본이지만, 변주가 돌면 3단계로 줄여 같은 순서가 반복되지 않게 한다.
  const countPool = maxCount >= 4 ? [4, 3] : [maxCount];
  const stepCount = countPool[variation % countPool.length] as number;
  const windows = Math.max(1, stepTemplates.length - stepCount + 1);
  const start = (variation + Math.floor(variation / countPool.length)) % windows;
  const steps = stepTemplates
    .slice(start, start + stepCount)
    .map((template) => ensureSentence(fillDomainTemplate(template, context)));
  const cta = ensureSentence(pickAt(bank.ctas[ctaGoal], hash + variation));

  const visuals = bank.visuals;
  const screens = bank.screens;
  const stepScreens = pack?.screens?.step ?? screens.step;
  const angleIndex = ANGLE_LIST.findIndex((entry) => entry.id === angle.id);

  const drafts: SceneDraft[] = [
    {
      beat: 'hook',
      narration: hook,
      onScreenText: fillDomainTemplate(pickAt(pack?.screens?.hook ?? screens.hook, angleIndex + variation), context).slice(0, 14),
      emphasis: [domain.name],
      visual: visuals[0],
    },
    {
      beat: 'problem',
      narration: problem,
      onScreenText: fillDomainTemplate(pickAt(pack?.screens?.problem ?? screens.problem, hash + variation), context).slice(0, 14),
      emphasis: [domain.name],
      visual: visuals[1] ?? visuals[0],
    },
    ...steps.map((step, index) => ({
      beat: 'solution' as const,
      narration: step,
      onScreenText: fillDomainTemplate(pickAt(stepScreens, index + hash), context).slice(0, 14),
      emphasis: [],
      visual: visuals[Math.min(visuals.length - 1, 2 + (index % 2))],
    })),
    {
      beat: 'cta',
      narration: cta,
      onScreenText: fillDomainTemplate(pickAt(screens.cta, hash + variation), context).slice(0, 14),
      emphasis: [],
      visual: visuals[visuals.length - 1] ?? visuals[0],
    },
  ];

  const caption = [hook, '', steps.map((step) => `· ${step}`).join('\n'), '', cta].join('\n');

  // 지식 팩이 걸리면 팩 이름을 태그로 쓴다("청년 월세 지원금" → #청년월세지원금).
  const primaryTag = pack
    ? pack.subject.replace(/[^가-힣A-Za-z0-9]/g, '')
    : (domain.subject
        .split(/\s+/)
        .map((token) => token.replace(/[^가-힣A-Za-z0-9]/g, ''))
        .find((token) => token.length >= 2 && !/^\d/.test(token)) ??
      domain.name.replace(/[^가-힣A-Za-z0-9]/g, ''));

  const hashtags = Array.from(
    new Set(
      [`#${primaryTag}`, ...(pack?.tags ?? []), ...SCRIPT_DOMAIN_TAGS[domain.id], '#숏폼'].filter(
        (tag) => tag.length > 1,
      ),
    ),
  ).slice(0, 8);

  return { domain, angle, variation, drafts, hook, cta, caption, hashtags };
}

/** 콘솔 표시용: "집·부동산 · 계약과 서류 · 반전형 · 변주 2". */
export function describeDomain(domain: ScriptDomainProfile): string {
  return `${domain.label} · ${domain.detail}`;
}

/** 도메인별 문장 품질 점검(테스트·검수 스크립트가 함께 쓴다). */
export interface DraftQualityReport {
  hookSeconds: number;
  hookOk: boolean;
  topicMentions: number;
  repeatedLines: string[];
  emptyScenes: number;
  sentences: number;
}

export function inspectDrafts(drafts: SceneDraft[], domain: ScriptDomainProfile): DraftQualityReport {
  const hook = drafts[0]?.narration ?? '';
  const hookSeconds = estimateSpeechSeconds(hook, { language: 'ko', speed: 1 });
  const lines = drafts.map((draft) => draft.narration.trim());
  const repeated = lines.filter((line, index) => line !== '' && lines.indexOf(line) !== index);
  const all = lines.join(' ');
  const nameTokens = domain.name
    .split(/\s+/)
    .map((token) => token.replace(/(의|은|는|이|가|을|를)$/u, '').replace(/[^\p{L}\p{N}]/gu, ''))
    .filter((token) => token.length >= 2);
  return {
    hookSeconds,
    // 훅은 긴 이름을 줄여 쓸 수 있다("인스타 릴스 대본" → "인스타 릴스").
    // 그래서 이름 전체가 아니라 이름을 이루는 낱말이 하나라도 들어 있는지로 본다.
    hookOk: hookSeconds <= 3.5 && (hook.includes(domain.name) || nameTokens.some((token) => hook.includes(token))),
    topicMentions: topicMentions(all, domain.name),
    repeatedLines: repeated,
    emptyScenes: drafts.filter((draft) => draft.narration.trim() === '').length,
    sentences: drafts.reduce((sum, draft) => sum + countSyllables(draft.narration), 0),
  };
}

/** 메타 라벨(콘솔이 "왜 이 대본인지" 한 줄로 보여줄 때). */
export function domainEvidence(domain: ScriptDomainProfile): string {
  const pack = domain.knowledge ? ` · ${domain.knowledge.pack.label}` : '';
  return (
    SCRIPT_DOMAIN_META[domain.id].label +
    pack +
    (domain.evidence.length > 0 ? ` (${domain.evidence.join(' ')})` : '')
  );
}
