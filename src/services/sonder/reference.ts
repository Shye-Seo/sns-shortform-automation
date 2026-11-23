/**
 * 참고 영상에서 "빌린 구조"를 뽑는다.
 *
 * 베끼는 것은 문장이 아니라 구조다. 첫 문장이 무엇으로 시선을 잡았는지, 어느
 * 초에 문제로 넘어가고 어느 초에 해결을 꺼내는지, 마지막에 무엇을 시키는지.
 * 그래서 입력은 제목·자막·길이고, 출력은 네 박자의 시간과 근거다.
 *
 * 자막이 없으면 제목으로 훅만 읽고 박자는 기본값으로 나눈다. 읽지 못한 것을
 * 읽은 척하지 않도록 `basis`에 무엇으로 계산했는지 남긴다.
 */
import { countSyllables, estimateSpeechSeconds } from '../../lib/text';
import {
  HOOK_PATTERN_LABEL,
  PLAN_GOAL_LABEL,
  type BorrowedBeat,
  type BorrowedStructure,
  type HookPattern,
  type PlanGoal,
} from './types';

export interface ReferenceInput {
  url?: string;
  title?: string;
  transcript?: string;
  durationSec?: number;
  author?: string;
}

export interface ReferenceAnalysis {
  structure: BorrowedStructure;
  title: string;
  author: string;
  platform: ReferencePlatform;
}

export type ReferencePlatform = 'youtube' | 'instagram' | 'tiktok' | 'other';

export interface ParsedReference {
  platform: ReferencePlatform;
  id: string;
  canonical: string;
}

/**
 * 플랫폼별 주소에서 영상 id만 꺼낸다. 주소를 못 읽어도 나머지 입력(제목·자막)만
 * 으로 구조를 뽑을 수 있으므로, 여기서 예외를 던지지 않는다.
 */
export function parseReferenceUrl(url: string): ParsedReference {
  const raw = (url ?? '').trim();
  const youtube =
    /youtu\.be\/([\w-]{6,})/.exec(raw) ??
    /youtube\.com\/shorts\/([\w-]{6,})/.exec(raw) ??
    /youtube\.com\/watch\?(?:.*&)?v=([\w-]{6,})/.exec(raw) ??
    /youtube\.com\/embed\/([\w-]{6,})/.exec(raw) ??
    /youtube\.com\/live\/([\w-]{6,})/.exec(raw);
  if (youtube) {
    const id = youtube[1] as string;
    return { platform: 'youtube', id, canonical: `https://www.youtube.com/watch?v=${id}` };
  }
  const instagram = /instagram\.com\/(?:reel|reels|p)\/([\w-]+)/.exec(raw);
  if (instagram) {
    const id = instagram[1] as string;
    return { platform: 'instagram', id, canonical: `https://www.instagram.com/reel/${id}/` };
  }
  const tiktok = /tiktok\.com\/@[\w.]+\/video\/(\d+)/.exec(raw) ?? /vm\.tiktok\.com\/(\w+)/.exec(raw);
  if (tiktok) {
    const id = tiktok[1] as string;
    return { platform: 'tiktok', id, canonical: raw };
  }
  return { platform: 'other', id: '', canonical: raw };
}

/**
 * 공개 oEmbed로 제목·작성자를 읽을 수 있는 주소. 인스타그램 oEmbed는 앱 토큰이
 * 있어야 해서 여기에 넣지 않는다(없으면 사용자가 적은 제목을 쓴다).
 */
export function oembedUrlFor(parsed: ParsedReference, originalUrl: string): string | null {
  if (parsed.platform === 'youtube') {
    return `https://www.youtube.com/oembed?url=${encodeURIComponent(parsed.canonical)}&format=json`;
  }
  if (parsed.platform === 'tiktok') {
    return `https://www.tiktok.com/oembed?url=${encodeURIComponent(originalUrl)}`;
  }
  return null;
}

export interface OembedMeta {
  title: string;
  author: string;
  thumbnailUrl: string;
}

export function readOembed(payload: unknown): OembedMeta | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const record = payload as Record<string, unknown>;
  const title = typeof record.title === 'string' ? record.title.trim() : '';
  if (title.length === 0) return null;
  return {
    title,
    author: typeof record.author_name === 'string' ? record.author_name.trim() : '',
    thumbnailUrl: typeof record.thumbnail_url === 'string' ? record.thumbnail_url : '',
  };
}

const PROBLEM_CUES = [
  '문제', '불편', '힘들', '안 되', '안돼', '못 ', '실패', '그런데', '근데', '하지만', '매번', '막히', '아깝', '낭비',
];
const SOLUTION_CUES = [
  '방법', '하면', '바꾸', '먼저', '이렇게', '순서', '체크', '정리', '설정', '단계', '그다음', '해보', '쓰면', '넣으면',
];
const CTA_CUES = ['저장', '댓글', '팔로우', '링크', '구독', '공유', '디엠', 'dm', '프로필', '더 보'];
const CONTRARIAN_CUES = [
  '하지 마', '하지마', '마세요', '마라', '그만', '반대로', '사실은', '틀렸', '잘못', '아닙니다', '아니에요', '말고', '빼고',
];
const HOWTO_CUES = [
  '방법', '하는 법', '어떻게', '순서', '단계', '체크리스트', '3가지', '세 가지', '확인할 것', '줄이세요', '바꾸', '먼저',
];
const KOREAN_NUMBER = /(한|두|세|네|다섯|여섯|일곱|여덟|아홉|열)\s*(가지|개|칸|번|분|초|명|곳|달|주|년|배)/;

const DEFAULT_SHARE = { hook: 0.16, problem: 0.22, solution: 0.49, cta: 0.13 } as const;

const BEAT_META: Record<BorrowedBeat['beat'], { label: string; intent: string }> = {
  hook: { label: '훅', intent: '첫 문장으로 스크롤을 멈추게 하는 구간' },
  problem: { label: '문제', intent: '시청자가 겪는 지점을 짚는 구간' },
  solution: { label: '해결', intent: '실행 방법을 꺼내는 가장 긴 구간' },
  cta: { label: '마무리', intent: '저장·댓글·링크 중 하나를 요구하는 구간' },
};

/** 문장 단위로 자른다. 줄바꿈과 마침표·물음표를 모두 경계로 본다. */
export function splitSentences(text: string): string[] {
  return (text ?? '')
    .replace(/\r/g, '')
    .split(/\n+/)
    // 목록 기호를 먼저 걷어낸다. "1. 문장"을 문장으로 자르면 "1."이 남는다.
    // 숫자로 시작하는 문장("3평 주방에서…")은 기호가 아니라서 그대로 둔다.
    .map((line) => line.replace(/^\s*(?:[-•*]|\d+[.)])\s+/, ''))
    .flatMap((line) => line.split(/(?<=[.!?。？！])\s+/))
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function scoreCues(sentence: string, cues: string[]): number {
  const lower = sentence.toLowerCase();
  return cues.reduce((score, cue) => (lower.includes(cue) ? score + 1 : score), 0);
}

export function detectHookPattern(sentence: string): HookPattern {
  const text = (sentence ?? '').trim();
  if (text.length === 0) return 'story';
  const scores: Record<HookPattern, number> = {
    question: /[?？]\s*$/.test(text) || /(까요|나요|가요|을까요|ㄹ까요|인가요)\s*$/.test(text) ? 2 : 0,
    numbers: (text.match(/\d+/g)?.length ?? 0) > 0 || KOREAN_NUMBER.test(text) ? 2 : 0,
    contrarian: scoreCues(text, CONTRARIAN_CUES) * 2,
    howto: scoreCues(text, HOWTO_CUES) * 2,
    story: 0.5,
  };
  const ranked = (Object.keys(scores) as HookPattern[]).sort((a, b) => scores[b] - scores[a]);
  const top = ranked[0] as HookPattern;
  return scores[top] > scores.story ? top : 'story';
}

export function detectGoal(sentence: string): PlanGoal | null {
  const text = (sentence ?? '').toLowerCase();
  if (!text) return null;
  if (text.includes('저장')) return 'save';
  if (text.includes('댓글') || text.includes('디엠') || text.includes('dm')) return 'comment';
  if (text.includes('팔로우') || text.includes('구독')) return 'follow';
  if (text.includes('링크') || text.includes('프로필')) return 'link';
  return null;
}

function round(value: number, digits = 1): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function beatTimes(
  sentences: string[],
  ranges: Record<BorrowedBeat['beat'], { from: number; to: number }>,
  durationSec: number,
): Record<BorrowedBeat['beat'], { sec: number; ratio: number }> {
  const weights = sentences.map((sentence) => Math.max(1, countSyllables(sentence)));
  const total = weights.reduce((sum, value) => sum + value, 0) || 1;
  const shares = {} as Record<BorrowedBeat['beat'], number>;
  (Object.keys(ranges) as Array<BorrowedBeat['beat']>).forEach((beat) => {
    const { from, to } = ranges[beat];
    const slice = weights.slice(from, to);
    shares[beat] = slice.length === 0 ? DEFAULT_SHARE[beat] : slice.reduce((sum, value) => sum + value, 0) / total;
  });
  // 자막이 비어 있는 박자가 있으면 기본 배분이 더해져 합이 1을 넘는다.
  // 그대로 두면 박자표 합계가 영상 길이와 어긋나므로 비율을 다시 맞춘다.
  const shareSum = (Object.values(shares) as number[]).reduce((sum, value) => sum + value, 0) || 1;
  const out = {} as Record<BorrowedBeat['beat'], { sec: number; ratio: number }>;
  (Object.keys(shares) as Array<BorrowedBeat['beat']>).forEach((beat) => {
    const share = (shares[beat] as number) / shareSum;
    out[beat] = { sec: round(durationSec * share, 1), ratio: round(share, 3) };
  });
  return out;
}

/**
 * 자막·제목·길이에서 구조를 만든다.
 * @throws 자막도 제목도 없을 때 — 읽을 것이 없으면 구조도 없다.
 */
export function analyzeReference(input: ReferenceInput): ReferenceAnalysis {
  const parsed = parseReferenceUrl(input.url ?? '');
  const transcript = (input.transcript ?? '').trim();
  const title = (input.title ?? '').trim();
  const sentences = splitSentences(transcript);
  const basis: BorrowedStructure['basis'] = [];

  if (title) basis.push('title');
  if (sentences.length > 0) basis.push('transcript');

  if (sentences.length === 0 && !title) {
    throw new Error('영상 제목이나 자막 중 하나는 있어야 구조를 읽을 수 있습니다');
  }

  const explicitDuration = Number.isFinite(input.durationSec) && (input.durationSec ?? 0) > 0 ? Number(input.durationSec) : 0;
  const estimated = sentences.length > 0 ? estimateSpeechSeconds(transcript, { language: 'ko', speed: 1 }) : 0;
  const durationSec = round(explicitDuration || estimated || 30, 1);
  if (explicitDuration) basis.push('duration');

  const hookLine = sentences[0] ?? title;
  const hookPattern = detectHookPattern(hookLine);
  const ctaSentence = [...sentences].reverse().find((sentence) => scoreCues(sentence, CTA_CUES) > 0) ?? '';
  const cta = ctaSentence || (sentences.length > 0 ? (sentences[sentences.length - 1] as string) : '');
  const goal = detectGoal(cta);

  const signals: string[] = [];
  signals.push(`첫 문장을 ${HOOK_PATTERN_LABEL[hookPattern]}으로 읽었습니다: “${hookLine.slice(0, 60)}”`);

  let beats: BorrowedBeat[];
  let transitions: number[] = [];

  if (sentences.length < 2) {
    // 자막이 한 줄뿐이면 박자를 나눌 근거가 없다. 기본 배분을 쓰고 그렇게 말한다.
    let cursor = 0;
    beats = (['hook', 'problem', 'solution', 'cta'] as const).map((beat) => {
      const sec = round(durationSec * DEFAULT_SHARE[beat], 1);
      const startSec = cursor;
      cursor = round(cursor + sec, 1);
      return {
        beat,
        label: BEAT_META[beat].label,
        intent: BEAT_META[beat].intent,
        startSec,
        endSec: cursor,
        ratio: DEFAULT_SHARE[beat],
      };
    });
    signals.push('자막이 한 줄뿐이라 박자는 기본 배분(훅 16% · 문제 22% · 해결 49% · 마무리 13%)으로 나눴습니다.');
  } else {
    const lastIdx = sentences.length - 1;
    const ctaIdx = ctaSentence ? sentences.lastIndexOf(ctaSentence) : lastIdx;
    const bodyEnd = Math.max(1, ctaIdx);
    let problemIdx = -1;
    for (let i = 1; i < bodyEnd; i += 1) {
      if (scoreCues(sentences[i] as string, PROBLEM_CUES) > 0) {
        problemIdx = i;
        break;
      }
    }
    if (problemIdx < 0 && bodyEnd > 1) problemIdx = 1;
    let solutionIdx = -1;
    for (let i = Math.max(1, problemIdx + 1); i < Math.max(bodyEnd, problemIdx + 1); i += 1) {
      if (scoreCues(sentences[i] as string, SOLUTION_CUES) > 0) {
        solutionIdx = i;
        break;
      }
    }
    if (solutionIdx < 0) solutionIdx = Math.min(bodyEnd, Math.max(problemIdx + 1, 1));
    if (problemIdx < 0) problemIdx = 0;

    const ranges = {
      hook: { from: 0, to: Math.max(1, problemIdx) },
      problem: { from: Math.max(1, problemIdx), to: Math.max(solutionIdx, problemIdx + 1) },
      solution: { from: Math.max(solutionIdx, problemIdx + 1), to: Math.max(bodyEnd, solutionIdx + 1) },
      cta: { from: Math.max(bodyEnd, 1), to: sentences.length },
    } as Record<BorrowedBeat['beat'], { from: number; to: number }>;

    const times = beatTimes(sentences, ranges, durationSec);
    let cursor = 0;
    beats = (['hook', 'problem', 'solution', 'cta'] as const).map((beat) => {
      const startSec = round(cursor, 1);
      cursor = round(cursor + times[beat].sec, 1);
      return {
        beat,
        label: BEAT_META[beat].label,
        intent: BEAT_META[beat].intent,
        startSec,
        endSec: startSec + times[beat].sec,
        ratio: times[beat].ratio,
      };
    });
    // 마지막 박자의 끝은 반올림 오차를 흡수해 전체 길이와 맞춘다.
    const lastBeat = beats[beats.length - 1] as BorrowedBeat;
    lastBeat.endSec = round(Math.max(lastBeat.endSec, cursor), 1);
    transitions = beats.slice(0, 3).map((beat) => beat.endSec);
    signals.push(`자막 ${sentences.length}문장을 음절 수로 나눠 박자를 잡았습니다. 전환 시점 ${transitions.map((sec) => `${sec}초`).join(' · ')}.`);
  }

  if (transitions.length === 0) transitions = beats.slice(0, 3).map((beat) => beat.endSec);

  const syllables = countSyllables(transcript || title);
  const pace = round(syllables / Math.max(1, durationSec), 2);
  signals.push(
    `${durationSec}초 · ${syllables}음절 기준 초당 ${pace}음절입니다. ${pace >= 6 ? '빠른 편이라 자막을 짧게 끊어야 합니다.' : pace <= 3.5 ? '느린 편이라 장면을 길게 잡아도 됩니다.' : '보통 속도입니다.'}`,
  );
  signals.push(
    goal
      ? `마지막 문장이 ${PLAN_GOAL_LABEL[goal]}을 요구합니다. 이 기획안의 마무리도 같은 행동으로 맞춥니다.`
      : '마지막 문장에서 요구 행동을 찾지 못해 마무리는 저장을 기본으로 둡니다.',
  );

  const structure: BorrowedStructure = {
    hookPattern,
    hookLine,
    beats,
    transitions,
    cta,
    goal,
    pace,
    durationSec,
    signals,
    basis,
  };

  return {
    structure,
    title: title || hookLine.slice(0, 80),
    author: (input.author ?? '').trim(),
    platform: parsed.platform,
  };
}
