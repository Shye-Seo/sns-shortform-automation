import type { Language } from '../types/script';

/**
 * Base articulation rates, measured on shortform narration at 1.0x.
 * Korean is counted in syllables (Hangul blocks), English in syllables too so
 * one code path can budget both: 5.4 syllables/sec ≈ 324 syllables/min, which
 * is the pace of a fast-but-clear Korean Reels voice-over.
 */
export const SPEECH_RATE: Record<Language, { syllablesPerSecond: number; unit: string }> = {
  ko: { syllablesPerSecond: 5.4, unit: 'syllable' },
  en: { syllablesPerSecond: 3.9, unit: 'syllable' },
};

/** Sentence-internal pause lengths, in seconds, at 1.0x. */
export const PAUSE_WEIGHTS = {
  comma: 0.1,
  dash: 0.08,
  period: 0.24,
  question: 0.26,
  ellipsis: 0.32,
  linebreak: 0.2,
} as const;

const HANGUL_RE = /[가-힣]/g;
const LATIN_WORD_RE = /[A-Za-z]+(?:['’][A-Za-z]+)?/g;
const NUMBER_RE = /\d+(?:[.,]\d+)*/g;

function countLatinSyllables(word: string): number {
  const groups = word.toLowerCase().match(/[aeiouy]+/g);
  const vowels = groups ? groups.length : 1;
  // Silent trailing "e" is common in English (make, time) — do not over-count.
  const silentE = /[^aeiouy]e$/.test(word.toLowerCase()) ? 1 : 0;
  return Math.max(1, vowels - silentE);
}

/**
 * Speech length in syllables. Hangul blocks count 1 each; Latin words are
 * counted by vowel groups; digit strings are read aloud so they cost roughly
 * one syllable per digit plus one.
 */
export function countSyllables(text: string): number {
  const hangul = (text.match(HANGUL_RE) ?? []).length;
  const latin = (text.match(LATIN_WORD_RE) ?? []).reduce(
    (sum, word) => sum + countLatinSyllables(word),
    0,
  );
  const digits = (text.match(NUMBER_RE) ?? []).reduce((sum, token) => {
    const raw = token.replace(/[^\d]/g, '');
    return sum + Math.max(1, raw.length + 1);
  }, 0);
  return hangul + latin + digits;
}

export interface PauseBreakdown {
  count: number;
  seconds: number;
}

export function countPauses(text: string): PauseBreakdown {
  const tally = (re: RegExp, weight: number) => {
    const matches = text.match(re);
    const count = matches ? matches.length : 0;
    return { count, seconds: count * weight };
  };
  const parts = [
    tally(/…/g, PAUSE_WEIGHTS.ellipsis),
    tally(/\.\.\./g, PAUSE_WEIGHTS.ellipsis),
    tally(/[.!?]/g, PAUSE_WEIGHTS.period),
    tally(/[?!]/g, PAUSE_WEIGHTS.question - PAUSE_WEIGHTS.period),
    tally(/[,、]/g, PAUSE_WEIGHTS.comma),
    tally(/[—–]/g, PAUSE_WEIGHTS.dash),
    tally(/\n/g, PAUSE_WEIGHTS.linebreak),
  ];
  return {
    count: parts.reduce((n, p) => n + p.count, 0),
    seconds: parts.reduce((n, p) => n + p.seconds, 0),
  };
}

export interface SpeechEstimateOptions {
  language?: Language;
  speed?: number;
  /** Base rate override, syllables per second at 1.0x. */
  syllablesPerSecond?: number;
}

export function estimateSpeechSeconds(text: string, options: SpeechEstimateOptions = {}): number {
  const language = options.language ?? 'ko';
  const speed = options.speed ?? 1;
  const rate = options.syllablesPerSecond ?? SPEECH_RATE[language].syllablesPerSecond;
  const syllables = countSyllables(text);
  const pauses = countPauses(text).seconds;
  if (syllables === 0) return 0;
  // Articulation scales with speed, breath pauses only partially.
  return syllables / (rate * speed) + pauses / Math.sqrt(speed);
}

export function normalizeWhitespace(text: string): string {
  return text.replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
}

export interface Token {
  /** Word without trailing punctuation. */
  text: string;
  /** Punctuation that followed the word, if any. */
  punctuation: string;
  endsSentence: boolean;
  /** Pause after this token, in seconds (unscaled). */
  pauseSec: number;
}

const TRAILING_PUNCT_RE = /([.,!?…:;'"”’)\]]+)$/u;

/**
 * Split narration into spoken words while keeping sentence boundaries, which
 * the subtitle grouper uses to avoid breaking a caption mid-sentence.
 */
export function tokenizeWords(text: string): Token[] {
  const tokens: Token[] = [];
  const chunks = normalizeWhitespace(text).split(/\s+/).filter(Boolean);
  for (const chunk of chunks) {
    const match = chunk.match(TRAILING_PUNCT_RE);
    const punctuation = match ? match[1] : '';
    const word = punctuation ? chunk.slice(0, -punctuation.length) : chunk;
    if (word) {
      const endsSentence = /[.!?…]/.test(punctuation);
      tokens.push({
        text: word,
        punctuation,
        endsSentence,
        pauseSec: pauseForPunctuation(punctuation),
      });
    } else if (tokens.length > 0) {
      // Standalone punctuation (e.g. "..." alone) attaches to the last word.
      const last = tokens[tokens.length - 1] as Token;
      last.punctuation += chunk;
      last.endsSentence = last.endsSentence || /[.!?…]/.test(chunk);
      last.pauseSec += pauseForPunctuation(chunk);
    }
  }
  return tokens;
}

export function pauseForPunctuation(punctuation: string): number {
  let pause = 0;
  if (/[.!?]/.test(punctuation)) pause += PAUSE_WEIGHTS.period;
  if (/[?!]/.test(punctuation)) pause += PAUSE_WEIGHTS.question - PAUSE_WEIGHTS.period;
  if (/[,…]/.test(punctuation)) pause += PAUSE_WEIGHTS.comma;
  if (/…|\.\.\./.test(punctuation)) pause += PAUSE_WEIGHTS.ellipsis;
  if (/[—–]/.test(punctuation)) pause += PAUSE_WEIGHTS.dash;
  return pause;
}

export function splitSentences(text: string): string[] {
  return normalizeWhitespace(text)
    .split(/(?<=[.!?…])\s+|\n+/u)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

const HANGUL_CHAR_RE = /[가-힣]/u;

export function isHangul(char: string): boolean {
  return HANGUL_CHAR_RE.test(char);
}

/**
 * Estimated advance width in pixels. Reels captions are burned in at a fixed
 * font size, so line breaks must be computed from glyph widths rather than
 * character counts — "MMMM" and "일이삼" are not the same box.
 */
export function measureTextPx(text: string, fontSizePx: number): number {
  let em = 0;
  for (const char of Array.from(text)) {
    if (char === ' ') em += 0.3;
    else if (/[가-힣]/.test(char)) em += 1;
    else if (/[0-9]/.test(char)) em += 0.56;
    else if (/[A-Z]/.test(char)) em += 0.66;
    else if (/[a-z]/.test(char)) em += 0.52;
    else if (/[.,!?:;'"()·…—–-]/.test(char)) em += 0.32;
    else if (/[\u3130-\u318F]/.test(char)) em += 0.9;
    else em += 0.55;
  }
  return em * fontSizePx;
}

export interface WrapOptions {
  maxWidthPx: number;
  fontSizePx: number;
  maxLines?: number;
}

/**
 * Dynamic-programming line breaker. Greedy wrapping leaves a single trailing
 * word on line two ("orphan"), which reads as a mistake at 1080x1920. The DP
 * minimises the sum of squared line slack instead and caps the line count.
 */
export function wrapText(text: string, options: WrapOptions): string[] {
  const requestedLines = options.maxLines ?? 2;
  const words = normalizeWhitespace(text).split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const spaceWidth = measureTextPx(' ', options.fontSizePx);
  const widths = words.map((word) => measureTextPx(word, options.fontSizePx));
  const n = words.length;

  const lineWidth = (from: number, to: number): number => {
    let width = 0;
    for (let i = from; i < to; i += 1) {
      width += widths[i] as number;
      if (i > from) width += spaceWidth;
    }
    return width;
  };

  /** Cheapest layout that fits exactly `lineCount` lines, or null. */
  const solveFor = (lineCount: number): number[] | null => {
    const best: number[][] = Array.from({ length: lineCount + 1 }, () =>
      new Array<number>(n + 1).fill(Number.POSITIVE_INFINITY),
    );
    const previous: number[][] = Array.from({ length: lineCount + 1 }, () =>
      new Array<number>(n + 1).fill(-1),
    );
    best[0]![0] = 0;

    for (let line = 1; line <= lineCount; line += 1) {
      for (let end = line; end <= n; end += 1) {
        for (let start = line - 1; start < end; start += 1) {
          const previousCost = best[line - 1]?.[start] as number;
          if (!Number.isFinite(previousCost)) continue;
          const width = lineWidth(start, end);
          // One oversized word is allowed (it is hard-split later); a line of
          // several words never overflows.
          if (width > options.maxWidthPx && end - start > 1) continue;
          const slack = Math.max(0, options.maxWidthPx - width);
          const cost = previousCost + slack * slack;
          if (cost < (best[line]?.[end] as number)) {
            best[line]![end] = cost;
            previous[line]![end] = start;
          }
        }
      }
    }

    if (!Number.isFinite(best[lineCount]?.[n] as number)) return null;

    const breaks: number[] = [];
    let end = n;
    for (let line = lineCount; line > 0; line -= 1) {
      breaks.unshift(end);
      end = previous[line]?.[end] as number;
      if (end < 0) return null;
    }
    breaks.unshift(0);
    return breaks;
  };

  // Fewest lines first: a caption that fits on two lines should never be
  // spread over three. The allowed ceiling is higher than `maxLines` so the
  // caller can see the overflow and split it into another cue.
  const ceiling = Math.max(requestedLines, 6);
  for (let lineCount = 1; lineCount <= Math.min(ceiling, n); lineCount += 1) {
    const breaks = solveFor(lineCount);
    if (!breaks) continue;
    const lines: string[] = [];
    for (let i = 1; i < breaks.length; i += 1) {
      const from = breaks[i - 1] as number;
      const to = breaks[i] as number;
      const line = words.slice(from, to).join(' ');
      if (measureTextPx(line, options.fontSizePx) > options.maxWidthPx && to - from === 1) {
        lines.push(...hardSplit(line, options));
      } else {
        lines.push(line);
      }
    }
    return lines;
  }

  return hardSplit(words.join(' '), options);
}

function hardSplit(text: string, options: WrapOptions): string[] {
  const chars = Array.from(text);
  const lines: string[] = [];
  let current = '';
  for (const char of chars) {
    const next = current + char;
    if (measureTextPx(next, options.fontSizePx) > options.maxWidthPx && current) {
      lines.push(current.trim());
      current = char;
    } else {
      current = next;
    }
  }
  if (current.trim()) lines.push(current.trim());
  return lines;
}

const KOREAN_PARTICLES = [
  '으로서',
  '으로써',
  '에서는',
  '에게서',
  '이라고',
  '라고는',
  '에서',
  '에게',
  '으로',
  '부터',
  '까지',
  '보다',
  '처럼',
  '만큼',
  '마다',
  '조차',
  '밖에',
  '이다',
  '입니다',
  '이에요',
  '예요',
  '은',
  '는',
  '이',
  '가',
  '을',
  '를',
  '의',
  '에',
  '로',
  '와',
  '과',
  '도',
  '만',
  '랑',
  '께',
].sort((a, b) => b.length - a.length);

export function stripKoreanParticle(token: string): string {
  let current = token;
  // "동작에만" carries two particles; strip in sequence but never below 2 chars.
  for (let pass = 0; pass < 2; pass += 1) {
    let stripped = false;
    for (const particle of KOREAN_PARTICLES) {
      if (current.length - particle.length >= 2 && current.endsWith(particle)) {
        current = current.slice(0, current.length - particle.length);
        stripped = true;
        break;
      }
    }
    if (!stripped) break;
  }
  return current;
}

const STOPWORDS_KO = new Set([
  '그리고',
  '하지만',
  '그래서',
  '그런데',
  '그러면',
  '저는',
  '제가',
  '내가',
  '너무',
  '정말',
  '진짜',
  '이거',
  '저거',
  '그거',
  '이것',
  '저것',
  '그것',
  '것',
  '수',
  '때',
  '좀',
  '더',
  '잘',
  '안',
  '못',
  '같이',
  '위해',
  '위한',
  '대한',
  '있는',
  '없는',
  '하는',
  '되는',
  '이런',
  '저런',
  '그런',
  '우리',
  '여러분',
  '그냥',
  '이제',
  '아직',
  '다시',
  '많이',
  '조금',
  '때문',
  '때문에',
  '경우',
  '정도',
  '생각',
  '사람',
  '부분',
  '방법',
  '이렇게',
  '저렇게',
  '그렇게',
  '하면',
  '해서',
  '하고',
  '합니다',
  '해요',
  '입니다',
  '있습니다',
  '없습니다',
]);

const STOPWORDS_EN = new Set([
  'the',
  'and',
  'for',
  'with',
  'that',
  'this',
  'you',
  'your',
  'are',
  'how',
  'why',
  'what',
  'when',
  'from',
  'into',
  'about',
  'just',
  'very',
  'really',
  'can',
  'will',
  'not',
  'but',
  'all',
  'get',
  'got',
  'has',
  'have',
  'our',
  'out',
  'was',
  'were',
  'they',
  'them',
  'then',
  'than',
  'too',
  'use',
  'using',
]);

export interface Keyword {
  term: string;
  score: number;
  count: number;
}

/** Tokens that name a content format rather than the subject. */
const FORMAT_WORDS = new Set([
  '방법',
  '정리법',
  '정리',
  '총정리',
  '가이드',
  '팁',
  '비법',
  '노하우',
  '이유',
  '추천',
  '후기',
  '리뷰',
  '비교',
  '정리하는',
  '방법은',
  'best',
  'tips',
  'guide',
  'review',
]);

/**
 * Korean predicate endings. A conjugated verb is not a topic: it produces
 * hashtags like #돌아왔죠, which is how hashtag sets get embarrassing.
 */
const KO_PREDICATE_ENDING =
  /(니다|습니다|합니다|됩니다|입니다|했다|한다|된다|있다|없다|같다|보세요|하세요|세요|나요|가요|까요|네요|죠|다|요|까|네|지|는데|지만|면서|고서|히|씩|대로|로|서|게|면|며|고|며\s*)$/u;

export function isKeywordCandidate(token: string, language: Language): boolean {
  if (language === 'ko') {
    if (token.length < 2) return false;
    if (!/[가-힣]/.test(token)) return false;
    if (STOPWORDS_KO.has(token)) return false;
    if (FORMAT_WORDS.has(token)) return false;
    if (KO_PREDICATE_ENDING.test(token)) return false;
    return true;
  }
  const lower = token.toLowerCase();
  if (token.length < 3) return false;
  if (!/^[a-z][a-z'-]*$/i.test(token)) return false;
  if (STOPWORDS_EN.has(lower)) return false;
  if (FORMAT_WORDS.has(lower)) return false;
  return true;
}

/**
 * Frequency + length keyword extraction. Long Korean compound nouns are kept
 * because they carry the topic ("주방수납", "실업급여"), while single-syllable
 * noise is dropped before scoring.
 */
export function extractKeywords(text: string, language: Language, limit = 8): Keyword[] {
  const tokens = normalizeWhitespace(text)
    .split(/[\s,.;:!?()[\]{}"'“”‘’·…—–/\\|]+/u)
    .map((token) => token.trim())
    .filter(Boolean);

  const counts = new Map<string, number>();
  for (const raw of tokens) {
    const token = language === 'ko' ? stripKoreanParticle(raw) : raw;
    if (!isKeywordCandidate(token, language)) continue;
    const lower = token.toLowerCase();
    counts.set(lower, (counts.get(lower) ?? 0) + 1);
  }

  return Array.from(counts.entries())
    .map(([term, count]) => ({
      term,
      count,
      score: count * (1 + Math.min(term.length, 8) * 0.15),
    }))
    .sort((a, b) => b.score - a.score || a.term.localeCompare(b.term))
    .slice(0, limit);
}

/**
 * The subject of a Korean title sits just before the format word
 * ("... 주방수납 정리법"). Taking the last one or two nouns before a format
 * word gives a much better hook keyword than frequency alone, which tends to
 * pick whichever word the body repeated most.
 */
export function topicHeadKeyword(topic: string, language: Language): string | null {
  const tokens = topic
    .split(/[\s,·/]+/u)
    .map((token) => stripKoreanParticle(token.replace(/[^\p{L}\p{N}]/gu, '')))
    .filter(Boolean);
  const formatIndex = tokens.findIndex((token) => FORMAT_WORDS.has(token));
  const pool = formatIndex > 0 ? tokens.slice(0, formatIndex) : tokens;
  const nounPool = pool.filter((token) => isKeywordCandidate(token, language));
  if (nounPool.length === 0) return null;

  if (formatIndex > 0 && nounPool.length >= 2) {
    const last = nounPool[nounPool.length - 1] as string;
    const previous = nounPool[nounPool.length - 2] as string;
    const compound = `${previous}${last}`;
    if (language === 'ko' && compound.length <= 8) return compound;
  }
  return nounPool.reduce((best, token) => (token.length >= best.length ? token : best), nounPool[0] as string);
}

export function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

export function escapeForDrawtext(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'")
    .replace(/%/g, '\\%');
}
