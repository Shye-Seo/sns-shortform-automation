import { estimateSpeechSeconds } from '../lib/text';
import type { CtaGoal, Language } from '../types/script';
import type { BlogPlatform, TopicProfile } from '../types/plan';
import type { SceneDraft } from './scriptEngine';
import { classifyTopic } from './topicProfile';
import { TOPIC_BANKS } from './topicBanks';
import { PATTERN_BY_CHANNEL } from './patternLibrary';

/**
 * OSMU (one source, multi use) converter.
 *
 * The studio already produced the four-beat script the video is rendered from.
 * This module takes *that script* — not a topic re-drafted from scratch — and
 * writes the three copy formats a Korean creator publishes next to the video:
 *
 *   reels   Instagram Reels caption (hook, numbered steps, save CTA, 5–8 tags)
 *   shorts  YouTube Shorts description (title, summary, beat timeline, 3 tags)
 *   summary Naver Blog summary post, and the same text split for Threads
 *
 * Why it is driven by the script: a caption written from the topic alone drifts
 * from the video the moment the writer edits a line in the studio. Reading the
 * same `SceneDraft[]` the timeline is built from means the caption says what the
 * video says, and the timeline below is the measured speech length of each beat.
 *
 * All limits are platform limits (Instagram 2,200 characters, YouTube description
 * 5,000, Threads 500 per post) plus the writing rules the pattern library already
 * states for each channel (Reels 5–8 tags, Shorts 3 tags or fewer). No engagement
 * number is claimed here.
 */

/** 요약 포스트를 올릴 곳. 블로그 플랫폼에 스레드를 더한 값이다 */
export type OsmuSummaryTarget = BlogPlatform | 'threads';

export const OSMU_FORMAT_IDS = ['reels', 'shorts', 'summary'] as const;
export type OsmuFormatId = (typeof OSMU_FORMAT_IDS)[number];

/** 플랫폼 글자 상한. 릴스 캡션·쇼츠 설명은 `types/script.ts`의 LIMITS와 같은 값이다. */
export const OSMU_LIMITS = {
  reelsCaption: 2_200,
  shortsDescription: 5_000,
  shortsTitle: 40,
  threadsPost: 500,
  reelsHashtagMin: 5,
  reelsHashtagMax: 8,
  shortsHashtagMax: 3,
  summaryHashtagMax: 5,
} as const;

const BEAT_LABEL: Record<string, string> = {
  hook: '훅',
  problem: '문제',
  solution: '해결',
  cta: '마지막 유도',
};

export interface OsmuInput {
  topic: string;
  /** 스튜디오가 만든 4비트 대본. 편집된 상태 그대로 받는다. */
  scenes: SceneDraft[];
  durationSec?: number;
  language?: Language;
  ctaGoal?: CtaGoal;
  /** 요약 포스트의 대상. 기본은 네이버 블로그 */
  platform?: OsmuSummaryTarget;
  /** 말 속도(스튜디오 슬라이더). 타임라인 추정에 쓴다 */
  speed?: number;
}

export interface OsmuBeat {
  index: number;
  beat: string;
  label: string;
  narration: string;
  startSec: number;
  endSec: number;
}

export interface OsmuCheck {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
}

export interface OsmuFormat {
  id: OsmuFormatId;
  label: string;
  channel: string;
  /** 글자 상한(플랫폼 제한) */
  limit: number;
  limitLabel: string;
  text: string;
  chars: number;
  hashtags: string[];
  checks: OsmuCheck[];
  /** 스레드용 분할(요약 포스트에서만). 각 글은 500자 이하 */
  threads?: string[];
  note: string;
}

export interface OsmuConversion {
  topic: string;
  profile: TopicProfile;
  beats: OsmuBeat[];
  formats: OsmuFormat[];
  /** 대본 자체에서 발견한 문제(훅 길이, 비트 누락 등) */
  warnings: string[];
  engine: 'osmu-rule-engine';
  engineDetail: string;
}

function clip(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length <= max ? clean : `${clean.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}

function firstClause(text: string, max = 30): string {
  const sentence = text.split(/(?<=[.!?])\s/)[0] ?? text;
  const clean = sentence.replace(/[.!?]$/, '').trim();
  return clean.length <= max ? clean : `${clean.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}

function timecode(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return `${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
}

/**
 * 비트 타임라인. 말 속도로 잰 길이를 목표 길이에 맞춰 비례 축소한다.
 * (스튜디오의 fitter가 하는 일과 같은 방향 — 다만 여기서는 캡션에 적을 시작 시각만 필요하다.)
 */
export function buildBeatTimeline(
  scenes: readonly SceneDraft[],
  options: { durationSec?: number; language?: Language; speed?: number } = {},
): OsmuBeat[] {
  const language = options.language ?? 'ko';
  const speed = options.speed ?? 1;
  const spoken = scenes.map((scene) => estimateSpeechSeconds(scene.narration, { language, speed }));
  const total = spoken.reduce((sum, value) => sum + value, 0);
  const target = Math.min(60, Math.max(10, options.durationSec ?? 45));
  const scale = total > target && total > 0 ? target / total : 1;

  let cursor = 0;
  return scenes.map((scene, index) => {
    const length = (spoken[index] ?? 0) * scale;
    const start = cursor;
    cursor += length;
    return {
      index,
      beat: scene.beat,
      label: BEAT_LABEL[scene.beat] ?? scene.beat,
      narration: scene.narration,
      startSec: Math.round(start * 10) / 10,
      endSec: Math.round(cursor * 10) / 10,
    };
  });
}

/** 주제은행에서 키워드를 가져와 해시태그로 만든다(공백 제거, 중복 제거). */
export function buildHashtags(profile: TopicProfile, limit: number): string[] {
  const bank = TOPIC_BANKS[profile.category];
  const raw = [profile.core, ...(bank?.keywords ?? []), profile.category, '정보공유', '일상기록'];
  const tags: string[] = [];
  const seen = new Set<string>();
  for (const word of raw) {
    const tag = `#${String(word).replace(/[^\p{L}\p{N}]/gu, '')}`;
    if (tag.length <= 1) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
    if (tags.length >= limit) break;
  }
  return tags;
}

const CTA_LINE: Record<CtaGoal, string> = {
  save: '다음에 또 볼 순서라서, 저장해두면 바로 따라 할 수 있습니다.',
  comment: '지금 어디서 막히는지 댓글로 알려주시면 다음 편에 반영하겠습니다.',
  follow: '이 순서대로 정리하는 시리즈를 계속 올립니다. 팔로우해두세요.',
  link: '체크리스트 원본은 프로필 링크에 정리해두었습니다.',
};

function checksFor(input: {
  format: OsmuFormatId;
  text: string;
  hashtags: string[];
  title: string;
  threads?: string[];
  beats: OsmuBeat[];
}): OsmuCheck[] {
  const { format, text, hashtags, title, threads, beats } = input;

  if (format === 'reels') {
    return [
      {
        id: 'tag-count',
        label: `해시태그 ${OSMU_LIMITS.reelsHashtagMin}~${OSMU_LIMITS.reelsHashtagMax}개`,
        ok: hashtags.length >= OSMU_LIMITS.reelsHashtagMin && hashtags.length <= OSMU_LIMITS.reelsHashtagMax,
        detail: `${hashtags.length}개`,
      },
      {
        id: 'save-cta',
        label: '저장 유도 문장 포함',
        ok: /저장/.test(text),
        detail: /저장/.test(text) ? '포함' : '없음',
      },
      {
        id: 'first-line',
        label: '첫 줄 60자 이내',
        ok: (text.split('\n')[0] ?? '').length <= 60,
        detail: `${(text.split('\n')[0] ?? '').length}자`,
      },
      {
        id: 'limit',
        label: `캡션 ${OSMU_LIMITS.reelsCaption.toLocaleString('ko-KR')}자 이내`,
        ok: text.length <= OSMU_LIMITS.reelsCaption,
        detail: `${text.length.toLocaleString('ko-KR')}자`,
      },
    ];
  }

  if (format === 'shorts') {
    const times = beats.map((beat) => beat.startSec);
    const ascending = times.every((value, index) => index === 0 || value >= (times[index - 1] ?? 0));
    return [
      {
        id: 'title',
        label: `제목 ${OSMU_LIMITS.shortsTitle}자 이내`,
        ok: title.length <= OSMU_LIMITS.shortsTitle,
        detail: `${title.length}자`,
      },
      {
        id: 'tag-count',
        label: `해시태그 ${OSMU_LIMITS.shortsHashtagMax}개 이내`,
        ok: hashtags.length <= OSMU_LIMITS.shortsHashtagMax,
        detail: `${hashtags.length}개`,
      },
      {
        id: 'timeline',
        label: '타임라인 오름차순',
        ok: ascending,
        detail: beats.map((beat) => timecode(beat.startSec)).join(' · '),
      },
      {
        id: 'limit',
        label: `설명 ${OSMU_LIMITS.shortsDescription.toLocaleString('ko-KR')}자 이내`,
        ok: text.length <= OSMU_LIMITS.shortsDescription,
        detail: `${text.length.toLocaleString('ko-KR')}자`,
      },
    ];
  }

  const chunks = threads ?? [];
  return [
    {
      id: 'thread-limit',
      label: `스레드 글당 ${OSMU_LIMITS.threadsPost}자 이내`,
      ok: chunks.length > 0 && chunks.every((chunk) => chunk.length <= OSMU_LIMITS.threadsPost),
      detail: chunks.map((chunk) => chunk.length).join(' / ') || '분할 없음',
    },
    {
      id: 'tag-count',
      label: `해시태그 ${OSMU_LIMITS.summaryHashtagMax}개 이내`,
      ok: hashtags.length <= OSMU_LIMITS.summaryHashtagMax,
      detail: `${hashtags.length}개`,
    },
    {
      id: 'length',
      label: '요약 250~1,200자',
      ok: text.length >= 250 && text.length <= 1_200,
      detail: `${text.length.toLocaleString('ko-KR')}자`,
    },
  ];
}

/** 스레드는 한 글이 500자를 넘을 수 없으므로 문장 단위로 쪼갠다. */
export function splitForThreads(text: string, limit = OSMU_LIMITS.threadsPost): string[] {
  const paragraphs = text.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
  const chunks: string[] = [];
  let current = '';

  const flush = (): void => {
    if (current.trim()) chunks.push(current.trim());
    current = '';
  };

  for (const paragraph of paragraphs) {
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (candidate.length <= limit) {
      current = candidate;
      continue;
    }
    flush();
    if (paragraph.length <= limit) {
      current = paragraph;
      continue;
    }
    // 문단 하나가 상한을 넘으면 문장 경계에서 자른다.
    const sentences = paragraph.split(/(?<=[.!?。])\s+/);
    for (const sentence of sentences) {
      const next = current ? `${current} ${sentence}` : sentence;
      if (next.length <= limit) {
        current = next;
      } else {
        flush();
        current = sentence.slice(0, limit);
      }
    }
  }
  flush();
  return chunks;
}

export function convertToOsmu(input: OsmuInput): OsmuConversion {
  const language = input.language ?? 'ko';
  const topic = input.topic.replace(/\s+/g, ' ').trim();
  const profile = classifyTopic(topic, language);
  const scenes = input.scenes.filter((scene) => scene.narration.trim().length > 0);
  const beats = buildBeatTimeline(scenes, {
    durationSec: input.durationSec,
    language,
    speed: input.speed,
  });

  const hook = scenes.find((scene) => scene.beat === 'hook')?.narration ?? scenes[0]?.narration ?? profile.subject;
  const problem = scenes.find((scene) => scene.beat === 'problem')?.narration ?? '';
  const steps = scenes.filter((scene) => scene.beat === 'solution').map((scene) => scene.narration.trim());
  const cta = scenes.find((scene) => scene.beat === 'cta')?.narration?.trim() ?? CTA_LINE[input.ctaGoal ?? 'save'];

  const warnings: string[] = [];
  if (!scenes.some((scene) => scene.beat === 'hook')) warnings.push('대본에 훅 비트가 없습니다.');
  if (steps.length === 0) warnings.push('해결 단계가 없어 캡션의 번호 목록이 비어 있습니다.');
  const hookSeconds = estimateSpeechSeconds(hook, { language, speed: input.speed ?? 1 });
  if (hookSeconds > 3.5) {
    warnings.push(`훅이 ${hookSeconds.toFixed(1)}초로 3.5초 상한을 넘습니다. 캡션에서는 첫 문장을 줄였습니다.`);
  }

  /* ── 1. 인스타그램 릴스 캡션 ─────────────────────────────── */
  const reelsTags = buildHashtags(profile, OSMU_LIMITS.reelsHashtagMax);
  const stepLines = steps.map((step, index) => `${index + 1}. ${step}`).join('\n');
  const reelsText = [
    firstClause(hook, 60),
    '',
    problem ? `왜 막히는지: ${problem}` : '',
    '',
    stepLines,
    '',
    CTA_LINE[input.ctaGoal ?? 'save'],
    '',
    reelsTags.join(' '),
  ]
    .filter((line, index, all) => !(line === '' && (all[index - 1] === '' || index === 0)))
    .join('\n')
    .trim();

  const reels: OsmuFormat = {
    id: 'reels',
    label: '인스타그램 릴스 캡션',
    channel: 'instagram-reels',
    limit: OSMU_LIMITS.reelsCaption,
    limitLabel: '2,200자',
    text: reelsText,
    chars: reelsText.length,
    hashtags: reelsTags,
    checks: checksFor({ format: 'reels', text: reelsText, hashtags: reelsTags, title: '', beats }),
    note: `첫 2줄에 결론, 마지막 줄에 저장 요청 — ${PATTERN_BY_CHANNEL['instagram-reels'].captionRule}`,
  };

  /* ── 2. 유튜브 쇼츠 설명 ────────────────────────────────── */
  const shortsTitle = clip(
    hook.length <= OSMU_LIMITS.shortsTitle ? hook.replace(/[?.!]$/, '') : `${profile.subject} ${steps.length}단계`,
    OSMU_LIMITS.shortsTitle,
  );
  const shortsTags = buildHashtags(profile, OSMU_LIMITS.shortsHashtagMax);
  const timeline = beats
    .map((beat) => `${timecode(beat.startSec)} ${beat.label} — ${firstClause(beat.narration, 34)}`)
    .join('\n');
  const shortsText = [
    shortsTitle,
    '',
    `${firstClause(hook, 50)}${problem ? ` ${firstClause(problem, 60)}` : ''}`.trim(),
    '',
    '타임라인',
    timeline,
    '',
    CTA_LINE[input.ctaGoal ?? 'save'],
    shortsTags.join(' '),
  ]
    .join('\n')
    .trim();

  const shorts: OsmuFormat = {
    id: 'shorts',
    label: '유튜브 쇼츠 설명',
    channel: 'youtube-shorts',
    limit: OSMU_LIMITS.shortsDescription,
    limitLabel: '5,000자',
    text: shortsText,
    chars: shortsText.length,
    hashtags: shortsTags,
    checks: checksFor({ format: 'shorts', text: shortsText, hashtags: shortsTags, title: shortsTitle, beats }),
    note: '제목·설명·첫 자막의 키워드를 같은 말로 맞춥니다. 해시태그는 3개 이내.',
  };

  /* ── 3. 블로그 / 스레드 요약 포스트 ──────────────────────── */
  const summaryTags = buildHashtags(profile, 3);
  const summaryTitle = clip(`${profile.subject} — ${steps.length}단계로 정리`, 55);
  const summaryText = [
    summaryTitle,
    '',
    firstClause(hook, 60),
    '',
    problem ? `${problem}` : '',
    '',
    ...steps.map((step, index) => `${index + 1}) ${step}`),
    '',
    cta,
    '',
    summaryTags.join(' '),
  ]
    .filter((line, index, all) => !(line === '' && (all[index - 1] === '' || index === 0)))
    .join('\n')
    .trim();
  const threads = splitForThreads(summaryText);

  const summary: OsmuFormat = {
    id: 'summary',
    label: '블로그 · 스레드 요약 포스트',
    channel: input.platform ?? 'naver-blog',
    limit: 1_200,
    limitLabel: '권장 1,200자',
    text: summaryText,
    chars: summaryText.length,
    hashtags: summaryTags,
    checks: checksFor({ format: 'summary', text: summaryText, hashtags: summaryTags, title: summaryTitle, beats, threads }),
    threads,
    note: `네이버 블로그는 요약, 스레드는 ${OSMU_LIMITS.threadsPost}자씩 이어 올립니다.`,
  };

  return {
    topic: profile.topic,
    profile,
    beats,
    formats: [reels, shorts, summary],
    warnings,
    engine: 'osmu-rule-engine',
    engineDetail: '스튜디오 대본 → 3개 포맷 · 외부 API 호출 없음',
  };
}
