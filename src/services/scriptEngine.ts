import { ShortformError } from '../lib/errors';
import { round, slugify, stableHash } from '../lib/ids';
import { silentLogger, type Logger } from '../lib/logger';
import {
  SPEECH_RATE,
  countSyllables,
  estimateSpeechSeconds,
  extractKeywords,
  normalizeWhitespace,
  splitSentences,
  tokenizeWords,
  topicHeadKeyword,
  truncate,
  type Keyword,
} from '../lib/text';
import {
  LIMITS,
  ScriptRequestSchema,
  ShortformScriptSchema,
  type Beat,
  type CompressionReport,
  type CtaGoal,
  type GenerationSource,
  type HookType,
  type Language,
  type Scene,
  type ScriptRequest,
  type ShortformScript,
} from '../types/script';

/* ────────────────────────────────────────────────────────────────────────────
 * 1. Time budget
 * ──────────────────────────────────────────────────────────────────────────── */

/** Breath / breathing room inserted after each scene, per beat. */
export const SCENE_GAP_SEC: Record<Beat, number> = {
  hook: 0.08,
  problem: 0.18,
  solution: 0.14,
  cta: 0.3,
};

const TAIL_SEC = 0.3;
/** Share of the speech budget each beat is allowed to occupy. */
const BEAT_SHARE: Record<Beat, number> = {
  hook: 0.16,
  problem: 0.22,
  solution: 0.49,
  cta: 0.13,
};

export interface TimeBudgetInput {
  targetDurationSec: number;
  language: Language;
  speed: number;
  /** Total scenes, hook and CTA included. */
  sceneCount: number;
}

export interface TimeBudget {
  targetDurationSec: number;
  language: Language;
  speed: number;
  syllablesPerSecond: number;
  /** Seconds of pure speech available after gaps are reserved. */
  speechBudgetSec: number;
  gapBudgetSec: number;
  capacitySyllables: number;
  perBeatSec: Record<Beat, number>;
  /** Compression ceilings per scene, in seconds. */
  sceneCapsSec: { hook: number; problem: number; solutionEach: number; cta: number };
  solutionSceneCount: number;
}

/**
 * Turn "60 seconds" into a syllable budget. Speech pauses are reserved first,
 * because a script that fits only when the gaps are removed is a script that
 * will be cut off by the platform's 60s limit after rendering.
 */
export function planTimeBudget(input: TimeBudgetInput): TimeBudget {
  const solutionSceneCount = Math.max(1, input.sceneCount - 3);
  const gapBudgetSec =
    SCENE_GAP_SEC.hook +
    SCENE_GAP_SEC.problem +
    SCENE_GAP_SEC.cta +
    SCENE_GAP_SEC.solution * solutionSceneCount +
    TAIL_SEC;

  // 0.3s safety margin absorbs per-scene rounding so the sum can never
  // cross the platform ceiling after the timeline is built.
  const speechBudgetSec = Math.max(4, input.targetDurationSec - gapBudgetSec - 0.3);
  const syllablesPerSecond = SPEECH_RATE[input.language].syllablesPerSecond * input.speed;

  const perBeatSec: Record<Beat, number> = {
    hook: Math.min(3, speechBudgetSec * BEAT_SHARE.hook),
    problem: speechBudgetSec * BEAT_SHARE.problem,
    solution: speechBudgetSec * BEAT_SHARE.solution,
    cta: speechBudgetSec * BEAT_SHARE.cta,
  };
  // Re-normalise the hook after the 3s ceiling so the other beats inherit the difference.
  const hookOverflow = speechBudgetSec * BEAT_SHARE.hook - perBeatSec.hook;
  if (hookOverflow > 0) {
    perBeatSec.problem += hookOverflow * 0.5;
    perBeatSec.solution += hookOverflow * 0.5;
  }

  return {
    targetDurationSec: input.targetDurationSec,
    language: input.language,
    speed: input.speed,
    syllablesPerSecond,
    speechBudgetSec,
    gapBudgetSec,
    capacitySyllables: Math.floor(speechBudgetSec * syllablesPerSecond),
    perBeatSec,
    sceneCapsSec: {
      // Leave room for the inter-scene gap so the scene itself lands under 3.5s.
      hook: Math.min(LIMITS.hookMaxDurationSec - 0.25, perBeatSec.hook + 0.25),
      problem: perBeatSec.problem,
      solutionEach: perBeatSec.solution / solutionSceneCount,
      cta: perBeatSec.cta,
    },
    solutionSceneCount,
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * 2. Compression
 * ──────────────────────────────────────────────────────────────────────────── */

export interface CompressionPassEntry {
  pass: 'parenthetical' | 'filler' | 'contraction' | 'sentence' | 'clause-trim';
  sceneId: string;
  removedText: string;
  savedSec: number;
}

export interface CompressResult {
  text: string;
  beforeSec: number;
  afterSec: number;
  passes: Array<Omit<CompressionPassEntry, 'sceneId'>>;
}

export interface CompressOptions {
  language: Language;
  speed: number;
  maxSec: number;
  /** The first sentence is the promise of the scene; never delete it. */
  protectFirstSentence?: boolean;
}

const KO_FILLERS = [
  '제가 보기에는',
  '제 생각에는',
  '말하자면',
  '그러니까',
  '그니까',
  '아무튼',
  '어쨌든',
  '솔직히',
  '사실은',
  '사실',
  '진짜',
  '정말',
  '약간',
  '그냥',
  '되게',
  '너무나',
  '너무',
  '뭔가',
  '일단',
  '역시',
  '완전',
  '엄청',
  '딱',
  '꽤',
  '결국에는',
  '결국',
  '좀',
];

const EN_FILLERS = [
  'actually',
  'really',
  'basically',
  'literally',
  'kind of',
  'sort of',
  'you know',
  'i mean',
  'just',
  'very',
  'quite',
  'totally',
  'super',
];

const KO_CONTRACTIONS: Array<[RegExp, string]> = [
  [/하는 것이 중요합니다/g, '중요합니다'],
  [/하는 게 중요합니다/g, '중요합니다'],
  [/하는 것이 좋습니다/g, '좋습니다'],
  [/하는 게 좋습니다/g, '좋습니다'],
  [/할 수가 있습니다/g, '가능합니다'],
  [/할 수 있습니다/g, '가능합니다'],
  [/것 같습니다/g, '같습니다'],
  [/하는 경우에는/g, '하면'],
  [/했을 때에는/g, '했을 때'],
  [/이것은/g, '이건'],
  [/저것은/g, '저건'],
  [/그것은/g, '그건'],
  [/무엇보다도/g, '무엇보다'],
  [/그런데 문제는/g, '문제는'],
  [/그래서 우리가/g, '그래서'],
  [/보시면 아시겠지만/g, '보시면'],
  [/다들 아시다시피/g, '아시다시피'],
  [/생각을 해보면/g, '보면'],
  [/정리를 해보면/g, '정리하면'],
  [/확인을 해보세요/g, '확인하세요'],
  [/시작을 해보세요/g, '시작하세요'],
];

const EN_CONTRACTIONS: Array<[RegExp, string]> = [
  [/in order to/gi, 'to'],
  [/due to the fact that/gi, 'because'],
  [/at this point in time/gi, 'now'],
  [/a lot of/gi, 'many'],
  [/in the event that/gi, 'if'],
  [/make sure to/gi, 'be sure to'],
  [/the reason why is that/gi, 'because'],
  [/is going to/gi, 'will'],
  [/want to/gi, 'wanna'],
];

/** Match a Korean filler as a standalone token (Hangul has no \b). */
function koreanTokenPattern(word: string): RegExp {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![가-힣])${escaped}(?![가-힣])`, 'g');
}

function tidySpacing(text: string): string {
  return text
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([,.!?…])/g, '$1')
    .replace(/^[\s,]+/, '')
    .replace(/,\s*,/g, ',')
    .trim();
}

function applyParenthetical(text: string): { text: string; removed: string } | null {
  const match = text.match(/(\([^)]{1,80}\)|\[[^\]]{1,80}\])/u);
  if (!match) return null;
  return {
    text: tidySpacing(text.replace(match[1] as string, ' ')),
    removed: match[1] as string,
  };
}

function applyFillers(text: string, language: Language): { text: string; removed: string } | null {
  const removed: string[] = [];
  let next = text;
  if (language === 'ko') {
    for (const filler of KO_FILLERS) {
      const before = next;
      next = next.replace(koreanTokenPattern(filler), ' ');
      if (next !== before) removed.push(filler);
    }
  } else {
    for (const filler of EN_FILLERS) {
      const pattern = new RegExp(`\\b${filler.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
      const before = next;
      next = next.replace(pattern, ' ');
      if (next !== before) removed.push(filler);
    }
  }
  if (removed.length === 0) return null;
  return { text: tidySpacing(next), removed: removed.join(', ') };
}

function applyContractions(text: string, language: Language): { text: string; removed: string } | null {
  const table = language === 'ko' ? KO_CONTRACTIONS : EN_CONTRACTIONS;
  let next = text;
  const removed: string[] = [];
  for (const [pattern, replacement] of table) {
    const before = next;
    next = next.replace(pattern, replacement);
    if (next !== before) removed.push(before.match(pattern)?.[0] ?? replacement);
  }
  if (removed.length === 0) return null;
  return { text: tidySpacing(next), removed: truncate(removed.join(', '), 60) };
}

/** Score a sentence for how much it carries: keyword hits per second. */
function sentenceValue(sentence: string, keywords: string[]): number {
  const seconds = Math.max(0.4, estimateSpeechSeconds(sentence, { language: 'ko' }));
  const hits = keywords.reduce(
    (sum, keyword) => (sentence.includes(keyword) ? sum + 1 : sum),
    0,
  );
  return (hits + 0.5) / seconds;
}

function applySentenceDrop(
  text: string,
  keywords: string[],
  protectFirst: boolean,
): { text: string; removed: string } | null {
  const sentences = splitSentences(text);
  if (sentences.length <= 1) return null;
  let candidateIndex = -1;
  let candidateScore = Number.POSITIVE_INFINITY;
  sentences.forEach((sentence, index) => {
    if (protectFirst && index === 0) return;
    const score = sentenceValue(sentence, keywords);
    if (score < candidateScore) {
      candidateScore = score;
      candidateIndex = index;
    }
  });
  if (candidateIndex < 0) return null;
  const removed = sentences[candidateIndex] as string;
  const remaining = sentences.filter((_, index) => index !== candidateIndex).join(' ');
  if (!remaining.trim()) return null;
  return { text: tidySpacing(remaining), removed };
}

function applyClauseTrim(text: string): { text: string; removed: string } | null {
  const sentences = splitSentences(text);
  const longest = sentences.reduce(
    (best, sentence) => (sentence.length > best.length ? sentence : best),
    '',
  );
  if (!longest) return null;

  const commaIndex = longest.lastIndexOf(',');
  if (commaIndex > 6) {
    const head = longest.slice(0, commaIndex).trim();
    if (countSyllables(head) >= 6) {
      return {
        text: tidySpacing(text.replace(longest, head)),
        removed: longest.slice(commaIndex + 1).trim(),
      };
    }
  }
  const connector = longest.search(/(?:는데|지만|면서|고서|하고)\s/u);
  if (connector > 8) {
    const head = longest.slice(0, connector).trim();
    if (countSyllables(head) >= 6) {
      return {
        text: tidySpacing(text.replace(longest, head)),
        removed: longest.slice(connector).trim(),
      };
    }
  }
  return null;
}

/**
 * Iteratively shrink a narration block until it fits `maxSec`.
 * Passes run most-meaning-preserving first: bracketed asides, filler words,
 * contractions, then whole low-value sentences, and only at the end a clause
 * trim. Each pass is measured, so the report always reconciles time saved.
 */
export function compressText(text: string, options: CompressOptions, keywords: string[] = []): CompressResult {
  const beforeSec = estimateSpeechSeconds(text, {
    language: options.language,
    speed: options.speed,
  });
  let current = normalizeWhitespace(text);
  const passes: Array<Omit<CompressionPassEntry, 'sceneId'>> = [];
  let guard = 0;
  const lexicalExhausted = { parenthetical: false, filler: false, contraction: false };

  const record = (
    pass: CompressionPassEntry['pass'],
    next: string,
    removed: string,
  ): void => {
    const savedSec = Math.max(
      0,
      estimateSpeechSeconds(current, { language: options.language, speed: options.speed }) -
        estimateSpeechSeconds(next, { language: options.language, speed: options.speed }),
    );
    passes.push({ pass, removedText: truncate(removed, 80), savedSec: round(savedSec, 3) });
    current = next;
  };

  while (
    estimateSpeechSeconds(current, { language: options.language, speed: options.speed }) >
      options.maxSec &&
    guard < 24
  ) {
    guard += 1;
    let changed = false;

    if (!lexicalExhausted.parenthetical) {
      const result = applyParenthetical(current);
      if (result) {
        record('parenthetical', result.text, result.removed);
        changed = true;
      } else {
        lexicalExhausted.parenthetical = true;
      }
    }

    if (!changed && !lexicalExhausted.filler) {
      const result = applyFillers(current, options.language);
      if (result) {
        record('filler', result.text, result.removed);
        changed = true;
      } else {
        lexicalExhausted.filler = true;
      }
    }

    if (!changed && !lexicalExhausted.contraction) {
      const result = applyContractions(current, options.language);
      if (result) {
        record('contraction', result.text, result.removed);
        changed = true;
      } else {
        lexicalExhausted.contraction = true;
      }
    }

    if (!changed) {
      const result = applySentenceDrop(current, keywords, options.protectFirstSentence ?? true);
      if (result) {
        record('sentence', result.text, result.removed);
        changed = true;
      }
    }

    if (!changed) {
      const result = applyClauseTrim(current);
      if (result) {
        record('clause-trim', result.text, result.removed);
        changed = true;
      }
    }

    if (!changed) break;
  }

  return {
    text: current,
    beforeSec: round(beforeSec, 3),
    afterSec: round(
      estimateSpeechSeconds(current, { language: options.language, speed: options.speed }),
      3,
    ),
    passes,
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * 3. Drafting (heuristic writer)
 * ──────────────────────────────────────────────────────────────────────────── */

export interface SceneDraft {
  beat: Beat;
  narration: string;
  onScreenText?: string;
  emphasis?: string[];
  visual?: string;
}

/**
 * Korean has particles that change shape by the preceding syllable, so
 * templates carry explicit slots instead of gluing "은/는" onto the keyword.
 * {keun}=은/는, {ki}=이/가, {keul}=을/를, {kwa}=와/과
 */
const HOOK_TEMPLATES: Record<HookType, Record<Language, string[]>> = {
  question: {
    ko: ['{k}, 아직도 이렇게 하고 있나요?', '{k}, 왜 매번 여기서 막힐까요?', '{k} 하나만 바꾸면 됩니다'],
    en: ['Still doing {k} this way?', 'Why does {k} keep stalling here?', 'One change fixes {k}.'],
  },
  numbers: {
    ko: ['{keun} 10명 중 9명이 놓칩니다', '{k}, 3분이면 정리됩니다', '{k}, 딱 세 가지만 기억하세요'],
    en: ['9 out of 10 people miss this in {k}', '{k}, fixed in 3 minutes', 'Remember just three things about {k}'],
  },
  shock: {
    ko: ['{k}, 이렇게 하면 시간만 버립니다', '{k}에서 제일 흔한 실수입니다', '{k}, 지금 방식이 문제입니다'],
    en: ['{k} is wasting your time', 'The most common {k} mistake', 'Your {k} approach is the problem'],
  },
  howto: {
    ko: ['{k}, 60초 안에 정리하는 법', '{k} 끝내는 순서, 이대로만 하세요', '{k} 3단계면 끝납니다'],
    en: ['How to fix {k} in 60 seconds', 'The exact order for {k}', '{k} in three steps'],
  },
  contrarian: {
    ko: ['{k}, 더 사면 안 됩니다', '{k}, 열심히 하는 게 답이 아닙니다', '{k}, 버려야 빨라집니다'],
    en: ['Stop buying more for {k}', 'Effort is not the answer for {k}', '{k} gets faster when you delete'],
  },
};

const PROBLEM_TEMPLATES: Record<Language, string[]> = {
  ko: [
    '대부분 {k}에서 같은 지점에 막힙니다.',
    '{k}, 해봤는데 금방 원래대로 돌아왔죠.',
    '문제는 {keul} 한 번에 다 하려는 겁니다.',
    '{k}에서 시간을 다 쓰고 정작 중요한 걸 놓칩니다.',
  ],
  en: [
    'Most people stall at the same point in {k}.',
    'You tried {k}, and it bounced right back.',
    'The problem is doing all of {k} at once.',
    '{k} eats the time you needed for what matters.',
  ],
};

const STEP_TEMPLATES: Record<Language, string[]> = {
  ko: [
    '첫째, {k}에서 제일 번거로운 한 가지를 먼저 없앱니다. 그게 하루에 몇 번인지 세어보면 답이 보입니다.',
    '둘째, 기준을 하나로 줄입니다. 예외를 만들면 다시 원래대로 돌아옵니다.',
    '셋째, 매일 반복되는 동작에만 붙입니다. 일주일에 한 번 쓰는 건 굳이 꺼내두지 않습니다.',
    '넷째, 일주일 뒤에 손이 먼저 움직이는지 봅니다. 그때 하나만 더 고치면 됩니다.',
  ],
  en: [
    'First, delete the single most annoying part of {k}. Count how often a day it costs you.',
    'Second, cut it to one rule. Every exception pulls you back to the start.',
    'Third, attach it to something you already do daily. Weekly items stay out of reach.',
    'Fourth, check in a week whether your hands move first. Then fix one more thing.',
  ],
};

const CTA_TEMPLATES: Record<CtaGoal, Record<Language, string[]>> = {
  follow: {
    ko: ['{k} 시리즈 계속 올립니다. 팔로우해두세요.', '다음 편은 {k} 마무리입니다. 팔로우!'],
    en: ['More {k} coming. Follow along.', 'Part two covers the rest of {k}. Follow.'],
  },
  save: {
    ko: ['{k} 할 때 다시 보려면 저장해두세요.', '나중에 또 헷갈립니다. 지금 저장하세요.'],
    en: ['Save this for your next {k} attempt.', 'You will need this again. Save it.'],
  },
  comment: {
    ko: ['{k}, 어디서 막히는지 댓글로 알려주세요.', '이 방법 써봤으면 댓글에 남겨주세요.'],
    en: ['Tell me where {k} breaks for you.', 'Tried this? Drop a comment.'],
  },
  link: {
    ko: ['{k} 체크리스트는 프로필 링크에 있습니다.', '자세한 순서는 프로필 링크에서 확인하세요.'],
    en: ['The full {k} checklist is in my profile link.', 'Full {k} guide is linked in my profile.'],
  },
};

const ON_SCREEN: Record<Beat, Record<Language, string[]>> = {
  hook: { ko: ['STOP', '이거 먼저', '3초 요약'], en: ['STOP', 'WATCH THIS', '60s'] },
  problem: { ko: ['왜 안 될까', '다들 여기서 막힘', '원인은 이거'], en: ['WHY IT FAILS', 'THE REAL CAUSE'] },
  solution: { ko: ['STEP 1', 'STEP 2', 'STEP 3', 'STEP 4'], en: ['STEP 1', 'STEP 2', 'STEP 3', 'STEP 4'] },
  cta: { ko: ['저장 필수', '팔로우', '댓글 주세요'], en: ['SAVE IT', 'FOLLOW', 'COMMENT'] },
};

function pick<T>(items: T[], seed: string, salt = ''): T {
  if (items.length === 0) throw new ShortformError('template list is empty', { code: 'CONFIG' });
  const index = parseInt(stableHash(seed, salt), 16) % items.length;
  return items[index] as T;
}

/** Korean particle selection: does the last syllable carry a final consonant? */
export function hasBatchim(word: string): boolean {
  const last = Array.from(word.trim()).pop();
  if (!last) return false;
  const code = last.charCodeAt(0);
  if (code < 0xac00 || code > 0xd7a3) return false;
  return (code - 0xac00) % 28 !== 0;
}

export function fill(template: string, keyword: string, language: Language): string {
  const withParticle = (consonant: string, vowel: string): string =>
    `${keyword}${hasBatchim(keyword) ? consonant : vowel}`;
  return template
    .replace(/\{keun\}/g, language === 'ko' ? withParticle('은', '는') : keyword)
    .replace(/\{ki\}/g, language === 'ko' ? withParticle('이', '가') : keyword)
    .replace(/\{keul\}/g, language === 'ko' ? withParticle('을', '를') : keyword)
    .replace(/\{kwa\}/g, language === 'ko' ? withParticle('과', '와') : keyword)
    .replace(/\{k\}/g, keyword);
}

export function keywordFor(request: ScriptRequest, keywords: Keyword[]): string {
  const head = topicHeadKeyword(request.topic, request.language);
  if (head) return head;
  const candidates = keywords.map((keyword) => keyword.term);
  if (candidates.length === 0) {
    const words = request.topic.split(/\s+/).filter(Boolean);
    return words[words.length - 1] ?? request.topic;
  }
  return candidates[0] as string;
}

export interface RawDraftInput {
  request: ScriptRequest;
  keywords: Keyword[];
}

export interface DrawDraftOptions {
  targetDurationSec?: number;
}

export function draftScenesHeuristic(
  { request, keywords }: RawDraftInput,
  options: DrawDraftOptions = {},
): SceneDraft[] {
  const keyword = keywordFor(request, keywords);
  const seed = `${request.topic}|${request.hookType}|${request.ctaGoal}`;
  const language = request.language;
  const drafts: SceneDraft[] = [];

  const hook = fill(pick(HOOK_TEMPLATES[request.hookType][language], seed, 'hook'), keyword, language);
  drafts.push({
    beat: 'hook',
    narration: hook,
    onScreenText: truncate(keyword, 14),
    emphasis: [keyword],
    visual: '빠른 줌인, 인물 클로즈업, 첫 프레임에 자막',
  });

  const problem = fill(pick(PROBLEM_TEMPLATES[language], seed, 'problem'), keyword, language);
  drafts.push({
    beat: 'problem',
    narration: problem,
    onScreenText: pick(ON_SCREEN.problem[language], seed, 'problem-screen'),
    emphasis: [keyword],
    visual: '문제 상황을 보여주는 B롤, 살짝 어두운 톤',
  });

  const rawSentences = request.rawText
    ? splitSentences(request.rawText)
        .filter((sentence) => tokenizeWords(sentence).length >= 3)
        .sort((a, b) => sentenceKeywordScore(b, keywords) - sentenceKeywordScore(a, keywords))
        .slice(0, 4)
        .sort((a, b) => (request.rawText ?? '').indexOf(a) - (request.rawText ?? '').indexOf(b))
    : [];

  const stepCount = Math.min(4, Math.max(2, Math.round((options.targetDurationSec ?? 60) / 16)));
  const steps =
    rawSentences.length > 0
      ? rawSentences
      : STEP_TEMPLATES[language].slice(0, stepCount).map((template) => fill(template, keyword, language));

  steps.forEach((step, index) => {
    drafts.push({
      beat: 'solution',
      narration: step,
      onScreenText: ON_SCREEN.solution[language][index] ?? `STEP ${index + 1}`,
      emphasis: keywords
        .map((k) => k.term)
        .filter((term) => step.includes(term))
        .slice(0, 2),
      visual: index === 0 ? '실제 손동작을 위에서 촬영' : '전후 비교 컷, 화면 분할',
    });
  });

  const cta = fill(pick(CTA_TEMPLATES[request.ctaGoal][language], seed, 'cta'), keyword, language);
  drafts.push({
    beat: 'cta',
    narration: cta,
    onScreenText: pick(ON_SCREEN.cta[language], seed, 'cta-screen'),
    emphasis: [],
    visual: 'CTA 자막 고정, 화면 하단 프로필 위치 표시',
  });

  return drafts;
}


function sentenceKeywordScore(sentence: string, keywords: Keyword[]): number {
  const seconds = Math.max(0.5, estimateSpeechSeconds(sentence, { language: 'ko' }));
  const hits = keywords.reduce(
    (sum, keyword) => (sentence.includes(keyword.term) ? sum + keyword.score : sum),
    0,
  );
  return hits / seconds;
}

/* ────────────────────────────────────────────────────────────────────────────
 * 4. Fitting and timeline assembly
 * ──────────────────────────────────────────────────────────────────────────── */

function measure(text: string, request: ScriptRequest): number {
  return estimateSpeechSeconds(text, { language: request.language, speed: request.speed });
}

export interface FitResult {
  drafts: SceneDraft[];
  compression: CompressionReport;
  speechSec: number;
}

export function fitDrafts(
  drafts: SceneDraft[],
  request: ScriptRequest,
  budget: TimeBudget,
  keywords: string[] = [],
): FitResult {
  const passes: CompressionPassEntry[] = [];
  const durations = drafts.map((draft) => measure(draft.narration, request));
  const requestedSec = round(
    durations.reduce((sum, value) => sum + value, 0),
    3,
  );
  const fitted = drafts.map((draft) => ({ ...draft }));

  const compressScene = (index: number, maxSec: number): boolean => {
    const draft = fitted[index] as SceneDraft;
    const result = compressText(
      draft.narration,
      {
        language: request.language,
        speed: request.speed,
        maxSec,
        protectFirstSentence: true,
      },
      keywords,
    );
    if (result.text === draft.narration) return false;
    result.passes.forEach((entry) =>
      passes.push({ ...entry, sceneId: `scene-${index + 1}` }),
    );
    fitted[index] = { ...draft, narration: result.text };
    durations[index] = result.afterSec;
    return true;
  };

  // The 3-second hook is a hard platform rule, not a share of the budget.
  const hookIndex = fitted.findIndex((draft) => draft.beat === 'hook');
  if (hookIndex >= 0 && (durations[hookIndex] as number) > budget.sceneCapsSec.hook) {
    compressScene(hookIndex, budget.sceneCapsSec.hook);
    // If the writer produced one long clause with nothing to cut, drop trailing
    // words rather than shipping a hook the 3.5s validator will reject.
    let guardTrim = 0;
    while (
      (durations[hookIndex] as number) > budget.sceneCapsSec.hook + 0.05 &&
      guardTrim < 12
    ) {
      guardTrim += 1;
      const hook = fitted[hookIndex] as SceneDraft;
      const words = hook.narration.split(/\s+/);
      if (words.length <= 3) break;
      const removed = words.pop() as string;
      fitted[hookIndex] = { ...hook, narration: words.join(' ') };
      durations[hookIndex] = measure(words.join(' '), request);
      passes.push({
        pass: 'clause-trim',
        sceneId: `scene-${hookIndex + 1}`,
        removedText: truncate(removed, 80),
        savedSec: 0,
      });
    }
  }

  // Everything else is only trimmed when the whole script is over budget, and
  // then the longest scene gives up time first — never the CTA.
  let guard = 0;
  const frozen = new Set<number>();
  const totalNow = (): number => durations.reduce((sum, value) => sum + value, 0);

  while (totalNow() > budget.speechBudgetSec + 0.02 && guard < 64) {
    guard += 1;
    let candidate = -1;
    let candidateDuration = 0;
    fitted.forEach((draft, index) => {
      if (draft.beat === 'hook' || frozen.has(index)) return;
      const duration = durations[index] as number;
      if (duration > candidateDuration) {
        candidate = index;
        candidateDuration = duration;
      }
    });
    if (candidate < 0) break;
    const nextCap = Math.max(1, candidateDuration * 0.9);
    if (!compressScene(candidate, nextCap)) {
      frozen.add(candidate);
    }
  }

  // Second sweep: walk the remaining long scenes from the tail.
  let sweep = 0;
  while (totalNow() > budget.speechBudgetSec + 0.02 && sweep < 32) {
    sweep += 1;
    let shrunk = false;
    for (let index = fitted.length - 1; index >= 0; index -= 1) {
      if (fitted[index]?.beat === 'hook' || frozen.has(index)) continue;
      const duration = durations[index] as number;
      if (duration <= 1) continue;
      if (compressScene(index, Math.max(1, duration * 0.85))) {
        shrunk = true;
        if (totalNow() <= budget.speechBudgetSec + 0.02) break;
      } else {
        frozen.add(index);
      }
    }
    if (!shrunk) break;
  }

  // Editorial fallback: when the copy cannot be compressed further, cut a whole
  // solution scene instead of shipping an over-length script. A 20s brief gets
  // two steps, not three crammed ones.
  let dropped = 0;
  while (totalNow() > budget.speechBudgetSec + 0.02 && dropped < 3) {
    const solutionIndexes = fitted
      .map((draft, index) => ({ draft, index }))
      .filter((entry) => entry.draft.beat === 'solution');
    if (solutionIndexes.length <= 1) break;
    const victim = solutionIndexes[solutionIndexes.length - 1] as { draft: SceneDraft; index: number };
    passes.push({
      pass: 'sentence',
      sceneId: `scene-${victim.index + 1}`,
      removedText: truncate(`장면 삭제: ${victim.draft.narration}`, 80),
      savedSec: round(durations[victim.index] as number, 3),
    });
    fitted.splice(victim.index, 1);
    durations.splice(victim.index, 1);
    frozen.clear();
    dropped += 1;
  }

  const speechSec = round(totalNow(), 3);
  if (speechSec > budget.speechBudgetSec + 0.06) {
    throw new ShortformError(
      `script still needs ${speechSec}s of speech but only ${round(budget.speechBudgetSec, 2)}s are available`,
      {
        code: 'VALIDATION',
        details: { speechSec, budget: budget.speechBudgetSec },
      },
    );
  }

  const savedSec = round(Math.max(0, requestedSec - speechSec), 3);
  return {
    drafts: fitted,
    speechSec,
    compression: {
      applied: passes.length > 0,
      requestedSec: round(requestedSec, 2),
      capacitySec: round(budget.speechBudgetSec, 2),
      savedSec,
      passes,
    },
  };
}

export interface TimelineResult {
  scenes: Scene[];
  totalDurationSec: number;
  speechSec: number;
  pauseSec: number;
}

/**
 * Build the absolute timeline. Leftover time is distributed as hold time so a
 * 60s slot is filled by pacing rather than by stretching the voice track.
 */
export function buildTimeline(
  drafts: SceneDraft[],
  request: ScriptRequest,
  targetDurationSec: number,
): TimelineResult {
  const speech = drafts.map((draft) => measure(draft.narration, request));
  const gaps = drafts.map((draft) => SCENE_GAP_SEC[draft.beat]);

  const usedRaw = speech.reduce((a, b) => a + b, 0) + gaps.reduce((a, b) => a + b, 0) + TAIL_SEC;
  let leftover = targetDurationSec - usedRaw;
  let overflow = 0;
  if (leftover < 0) {
    overflow = -leftover;
    leftover = 0;
    // Trim gaps before touching narration; 0.05s is the floor.
    for (let i = 0; i < gaps.length && overflow > 0; i += 1) {
      const trim = Math.min(overflow, (gaps[i] as number) - 0.05);
      if (trim > 0) {
        gaps[i] = (gaps[i] as number) - trim;
        overflow -= trim;
      }
    }
  }

  // Breathing room is capped: a 20s idea stretched to 60s by holding frames is
  // worse than a tight 35s video. The remainder stays unused and is reported.
  const holds = new Array<number>(drafts.length).fill(0);
  if (leftover > 0) {
    const perScene = Math.min(0.6, leftover / drafts.length);
    for (let i = 0; i < holds.length; i += 1) {
      // The hook is capped at 3.5s end to end, so it never takes hold time.
      holds[i] = drafts[i]?.beat === 'hook' ? 0 : perScene;
    }
    let rest = leftover - perScene * drafts.length;
    // Extra time goes to the CTA slide, where the viewer needs a beat to act.
    const ctaIndex = holds.length - 1;
    const ctaExtra = Math.min(1.2, rest);
    holds[ctaIndex] = (holds[ctaIndex] as number) + ctaExtra;
    rest -= ctaExtra;
    if (rest > 0.001) holds[1] = (holds[1] as number) + Math.min(0.6, rest);
  }

  const scenes: Scene[] = [];
  let cursor = 0;
  drafts.forEach((draft, index) => {
    const duration = Math.max(
      0.6,
      Math.floor(((speech[index] as number) + (gaps[index] as number) + (holds[index] as number)) * 100) /
        100,
    );
    const scene: Scene = {
      id: `s${index + 1}`,
      beat: draft.beat,
      index,
      narration: draft.narration,
      onScreenText: draft.onScreenText,
      emphasis: draft.emphasis ?? [],
      visual: draft.visual,
      startSec: round(cursor, 2),
      durationSec: round(duration, 2),
      estimatedSpeechSec: round(speech[index] as number, 2),
      syllables: countSyllables(draft.narration),
    };
    cursor += duration;
    scenes.push(scene);
  });

  // Final clamp: never cross the target because of accumulated rounding.
  let excess = round(cursor - targetDurationSec, 3);
  if (excess > 0.005) {
    const order = scenes
      .map((scene, index) => ({ scene, index, room: scene.durationSec - ((speech[index] as number) + 0.03) }))
      .filter((entry) => entry.room > 0)
      .sort((a, b) => b.room - a.room);
    for (const entry of order) {
      if (excess <= 0.005) break;
      const cut = Math.min(entry.room, excess);
      entry.scene.durationSec = round(entry.scene.durationSec - cut, 2);
      excess = round(excess - cut, 3);
    }
    let restarted = 0;
    for (const scene of scenes) {
      scene.startSec = round(restarted, 2);
      restarted += scene.durationSec;
    }
    cursor = round(restarted, 2);
  }

  const totalDurationSec = round(cursor, 2);
  const speechSec = round(
    speech.reduce((a, b) => a + b, 0),
    2,
  );
  return {
    scenes,
    totalDurationSec,
    speechSec,
    pauseSec: round(Math.max(0, totalDurationSec - speechSec), 2),
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * 5. Caption & hashtags
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Hashtags come from the topic and source material only. Drawing them from the
 * narration is how a tag set ends up as #돌아왔죠 #번거로운 — technically
 * unique words, useless as discovery tags.
 */
export function buildHashtags(
  request: ScriptRequest,
  keywords: Keyword[],
): string[] {
  const base = request.language === 'ko' ? ['#릴스', '#shorts', '#숏폼'] : ['#reels', '#shorts', '#shortform'];
  const head = topicHeadKeyword(request.topic, request.language);
  const topicTags = [head, ...keywords.map((keyword) => keyword.term)]
    .filter((term): term is string => Boolean(term))
    .map((term) => `#${term.replace(/[^\p{L}\p{N}_]/gu, '')}`)
    .filter((tag) => tag.length > 2);
  const explicit = request.hashtags ?? [];
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const tag of [...explicit, ...base, ...topicTags]) {
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(tag);
  }
  return merged.slice(0, 8);
}

export function buildCaption(
  scenes: Scene[],
  request: ScriptRequest,
  hashtags: string[],
): string {
  const hook = scenes.find((scene) => scene.beat === 'hook')?.narration ?? request.topic;
  const cta = scenes.find((scene) => scene.beat === 'cta')?.narration ?? '';
  const body = scenes
    .filter((scene) => scene.beat === 'solution')
    .map((scene) => `· ${scene.onScreenText ? scene.onScreenText + ' — ' : ''}${scene.narration}`)
    .join('\n');

  const text = [truncate(hook, 120), '', body, '', truncate(cta, 120), '', hashtags.join(' ')]
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
  return truncate(text, LIMITS.captionMaxChars - 1).trim();
}

/* ────────────────────────────────────────────────────────────────────────────
 * 6. Optional model writer
 * ──────────────────────────────────────────────────────────────────────────── */

export interface ScriptModel {
  readonly name: string;
  complete(prompt: string, options?: { system?: string }): Promise<string>;
}

export interface OpenAiScriptModelOptions {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export function createOpenAiScriptModel(options: OpenAiScriptModelOptions = {}): ScriptModel {
  const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new ShortformError('OPENAI_API_KEY is not set', {
      code: 'CONFIG',
      details: { env: 'OPENAI_API_KEY' },
    });
  }
  const model = options.model ?? process.env.OPENAI_SCRIPT_MODEL ?? 'gpt-4o-mini';
  const baseUrl = options.baseUrl ?? 'https://api.openai.com/v1';
  const fetchImpl = options.fetchImpl ?? fetch;

  return {
    name: `openai:${model}`,
    async complete(prompt, completeOptions) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 45_000);
      try {
        const response = await fetchImpl(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model,
            temperature: 0.7,
            response_format: { type: 'json_object' },
            messages: [
              ...(completeOptions?.system ? [{ role: 'system', content: completeOptions.system }] : []),
              { role: 'user', content: prompt },
            ],
          }),
          signal: controller.signal,
        });
        const body = (await response.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
          error?: { message?: string };
        };
        if (!response.ok) {
          throw new ShortformError(`OpenAI request failed (${response.status})`, {
            code: 'EXTERNAL',
            retryable: response.status === 429 || response.status >= 500,
            details: { message: body.error?.message },
          });
        }
        const content = body.choices?.[0]?.message?.content;
        if (!content) {
          throw new ShortformError('OpenAI returned an empty completion', { code: 'EXTERNAL' });
        }
        return content;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export interface ScriptPrompt {
  system: string;
  user: string;
}

export function buildScriptPrompt(request: ScriptRequest, budget: TimeBudget): ScriptPrompt {
  const caps = budget.sceneCapsSec;
  const ko = request.language === 'ko';
  const system = ko
    ? [
        '당신은 릴스·쇼츠 60초 대본 작가입니다.',
        '규칙: 첫 3초 안에 훅. 광고 문구 금지. 숫자와 구체적 행동만. 문장은 짧게.',
        '가능하면 3인칭 일반화 대신 시청자에게 말을 거는 2인칭을 씁니다.',
        '반드시 JSON만 출력합니다.',
      ].join(' ')
    : [
        'You write 60-second Reels/Shorts scripts.',
        'Rules: hook inside the first 3 seconds, no ad copy, concrete actions and numbers, short sentences.',
        'Output JSON only.',
      ].join(' ');

  const user = [
    `topic: ${request.topic}`,
    `language: ${request.language}`,
    `tone: ${request.tone}`,
    `hookType: ${request.hookType}`,
    `ctaGoal: ${request.ctaGoal}`,
    `total target: ${request.targetDurationSec}s (hard ceiling ${LIMITS.shortformMaxDurationSec}s)`,
    `hook must end by ${round(caps.hook, 1)}s; problem ≤ ${round(caps.problem, 1)}s; each solution step ≤ ${round(caps.solutionEach, 1)}s; CTA ≤ ${round(caps.cta, 1)}s`,
    `speech rate: ${round(budget.syllablesPerSecond, 2)} syllables/sec — stay inside the budget`,
    request.rawText ? `source material:\n${truncate(request.rawText, 4000)}` : '',
    '',
    'Return: {"title":string,"scenes":[{"beat":"hook"|"problem"|"solution"|"cta","narration":string,"onScreenText":string,"emphasis":string[],"visual":string}],"caption":string,"hashtags":string[]}',
    'Exactly one hook first, exactly one cta last, 1-3 solution scenes in between.',
  ]
    .filter(Boolean)
    .join('\n');

  return { system, user };
}

export function parseModelJson(raw: string): unknown {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/u);
  const candidate = (fenced ? (fenced[1] as string) : raw).trim();
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) {
    throw new ShortformError('model response contains no JSON object', {
      code: 'VALIDATION',
    });
  }
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch (error) {
    throw new ShortformError('model response is not valid JSON', {
      code: 'VALIDATION',
      cause: error,
    });
  }
}

interface ModelDraftPayload {
  title?: unknown;
  scenes?: Array<Record<string, unknown>>;
  caption?: unknown;
  hashtags?: unknown;
}

export function draftsFromModelPayload(payload: unknown): { drafts: SceneDraft[]; title?: string } {
  const data = payload as ModelDraftPayload;
  if (!Array.isArray(data.scenes) || data.scenes.length < 3) {
    throw new ShortformError('model output is missing scenes', { code: 'VALIDATION' });
  }
  const validBeats: Beat[] = ['hook', 'problem', 'solution', 'cta'];
  const drafts: SceneDraft[] = data.scenes.map((scene, index) => {
    const beat = String(scene.beat ?? '') as Beat;
    if (!validBeats.includes(beat)) {
      throw new ShortformError(`model scene ${index} has an invalid beat "${String(scene.beat)}"`, {
        code: 'VALIDATION',
      });
    }
    const narration = String(scene.narration ?? '').trim();
    if (!narration) {
      throw new ShortformError(`model scene ${index} has empty narration`, { code: 'VALIDATION' });
    }
    return {
      beat,
      narration,
      onScreenText:
        typeof scene.onScreenText === 'string' ? scene.onScreenText.slice(0, 42) : undefined,
      emphasis: Array.isArray(scene.emphasis)
        ? scene.emphasis.filter((word): word is string => typeof word === 'string').slice(0, 10)
        : [],
      visual: typeof scene.visual === 'string' ? scene.visual.slice(0, 240) : undefined,
    };
  });
  return { drafts, title: typeof data.title === 'string' ? data.title : undefined };
}

/* ────────────────────────────────────────────────────────────────────────────
 * 7. Engine
 * ──────────────────────────────────────────────────────────────────────────── */

export interface ScriptEngineOptions {
  model?: ScriptModel;
  logger?: Logger;
  now?: () => Date;
}

export interface CraftResult {
  script: ShortformScript;
  warnings: string[];
}

export class ScriptEngine {
  private readonly model?: ScriptModel;
  private readonly logger: Logger;
  private readonly now: () => Date;

  constructor(options: ScriptEngineOptions = {}) {
    this.model = options.model;
    this.logger = options.logger ?? silentLogger;
    this.now = options.now ?? (() => new Date());
  }

  async craft(input: unknown): Promise<CraftResult> {
    const request = ScriptRequestSchema.parse(input);
    const warnings: string[] = [];

    let drafts: SceneDraft[];
    let generationSource: GenerationSource = 'heuristic';
    let title = request.topic;

    if (this.model) {
      const budget = planTimeBudget({
        targetDurationSec: request.targetDurationSec,
        language: request.language,
        speed: request.speed,
        sceneCount: 6,
      });
      const prompt = buildScriptPrompt(request, budget);
      try {
        const raw = await this.model.complete(prompt.user, { system: prompt.system });
        const parsed = draftsFromModelPayload(parseModelJson(raw));
        drafts = parsed.drafts;
        title = parsed.title ?? title;
        generationSource = 'model';
      } catch (error) {
        warnings.push(
          `model draft rejected, using heuristic writer: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        this.logger.warn('model draft rejected', { error: String(error) });
        drafts = draftScenesHeuristic(
          {
            request,
            keywords: extractKeywords(`${request.topic} ${request.rawText ?? ''}`, request.language),
          },
          { targetDurationSec: request.targetDurationSec },
        );
        generationSource = 'heuristic-fallback';
      }
    } else {
      drafts = draftScenesHeuristic(
        {
          request,
          keywords: extractKeywords(`${request.topic} ${request.rawText ?? ''}`, request.language),
        },
        { targetDurationSec: request.targetDurationSec },
      );
    }

    drafts = this.normalizeBeats(drafts);
    const keywords = extractKeywords(
      `${request.topic} ${request.rawText ?? ''} ${drafts.map((d) => d.narration).join(' ')}`,
      request.language,
      10,
    );
    const keywordStrings = keywords.map((keyword) => keyword.term);

    const budget = planTimeBudget({
      targetDurationSec: request.targetDurationSec,
      language: request.language,
      speed: request.speed,
      sceneCount: drafts.length,
    });

    const fitted = fitDrafts(drafts, request, budget, keywordStrings);
    const timeline = buildTimeline(fitted.drafts, request, request.targetDurationSec);
    const hashtagKeywords = extractKeywords(
      `${request.topic} ${request.rawText ?? ''}`,
      request.language,
      6,
    );
    const hashtags = buildHashtags(request, hashtagKeywords);
    const caption = buildCaption(timeline.scenes, request, hashtags);

    const totalWords = timeline.scenes.reduce(
      (sum, scene) => sum + tokenizeWords(scene.narration).length,
      0,
    );
    const script: ShortformScript = {
      schemaVersion: '1.0',
      id: `sf_${stableHash(request.topic, request.language, request.targetDurationSec.toString(), this.now().toISOString())}`,
      title: truncate(title, LIMITS.titleMaxChars),
      topic: request.topic,
      language: request.language,
      targetDurationSec: request.targetDurationSec,
      speed: request.speed,
      hookType: request.hookType,
      ctaGoal: request.ctaGoal,
      scenes: timeline.scenes,
      caption,
      hashtags,
      generationSource,
      keywords: keywordStrings,
      metrics: {
        totalDurationSec: timeline.totalDurationSec,
        speechSec: timeline.speechSec,
        pauseSec: timeline.pauseSec,
        syllables: timeline.scenes.reduce((sum, scene) => sum + scene.syllables, 0),
        wordsPerMinute:
          timeline.speechSec > 0 ? round((totalWords / timeline.speechSec) * 60, 1) : 0,
        syllablesPerSecond:
          timeline.speechSec > 0
            ? round(
                timeline.scenes.reduce((sum, scene) => sum + scene.syllables, 0) / timeline.speechSec,
                2,
              )
            : 0,
        hookDurationSec:
          timeline.scenes.find((scene) => scene.beat === 'hook')?.durationSec ?? 0,
        ctaDurationSec: timeline.scenes.find((scene) => scene.beat === 'cta')?.durationSec ?? 0,
      },
      compression: fitted.compression,
      createdAt: this.now().toISOString(),
    };

    return { script: ShortformScriptSchema.parse(script), warnings };
  }

  /**
   * Guarantee the four-beat contract even when a model returns two hooks or
   * forgets the CTA. Later hooks are demoted to problem scenes, and a missing
   * CTA is appended from the template set.
   */
  private normalizeBeats(drafts: SceneDraft[]): SceneDraft[] {
    const cleaned = drafts
      .map((draft) => ({ ...draft, narration: normalizeWhitespace(draft.narration) }))
      .filter((draft) => draft.narration.length > 0);

    const hookIndex = cleaned.findIndex((draft) => draft.beat === 'hook');
    const ctaIndex = cleaned.map((draft) => draft.beat).lastIndexOf('cta');

    const ordered: SceneDraft[] = [];
    // A hook that arrives late still opens the video; only the first is kept.
    if (hookIndex > 0) ordered.push(cleaned[hookIndex] as SceneDraft);
    cleaned.forEach((draft, index) => {
      if (draft.beat === 'hook') {
        if (index !== hookIndex) ordered.push({ ...draft, beat: 'problem' });
        else if (hookIndex === 0) ordered.push(draft);
      } else if (draft.beat === 'cta') {
        if (index !== ctaIndex) ordered.push({ ...draft, beat: 'solution' });
        // The surviving CTA is appended below, so it always closes the video.
      } else {
        ordered.push(draft);
      }
    });
    if (ctaIndex>=0 && !ordered.some((draft) => draft.beat === 'cta')) {
      ordered.push(cleaned[ctaIndex] as SceneDraft);
    }

    if (ordered.length === 0) {
      throw new ShortformError('no scenes to assemble', { code: 'VALIDATION' });
    }
    if (ordered[0]?.beat !== 'hook') {
      ordered.unshift({
        beat: 'hook',
        narration: '이거, 3초만 보세요.',
        onScreenText: '3초 요약',
      });
    }
    if (ordered[ordered.length - 1]?.beat !== 'cta') {
      ordered.push({
        beat: 'cta',
        narration: '저장해두고 필요할 때 다시 보세요.',
        onScreenText: '저장 필수',
      });
    }
    if (!ordered.some((draft) => draft.beat === 'problem')) {
      const insertAt = 1;
      ordered.splice(insertAt, 0, {
        beat: 'problem',
        narration: '대부분 같은 지점에서 막힙니다.',
        onScreenText: '다들 여기서 막힘',
      });
    }
    if (!ordered.some((draft) => draft.beat === 'solution')) {
      ordered.splice(ordered.length - 1, 0, {
        beat: 'solution',
        narration: '기준을 하나로 줄이면 훨씬 빨라집니다.',
        onScreenText: 'STEP 1',
      });
    }

    return ordered.map((draft) => ({ ...draft, emphasis: draft.emphasis ?? [] }));
  }
}

export function createScriptEngine(options: ScriptEngineOptions = {}): ScriptEngine {
  return new ScriptEngine(options);
}

export function scriptFileName(script: ShortformScript): string {
  return `${slugify(script.title)}-${script.id.slice(-4)}.json`;
}
