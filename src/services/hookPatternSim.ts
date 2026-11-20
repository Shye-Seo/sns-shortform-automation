import { estimateSpeechSeconds } from '../lib/text';
import type { Language } from '../types/script';
import type { AngleId, TopicCategory, TopicProfile } from '../types/plan';
import { classifyTopic } from './topicProfile';
import { writeTopicDrafts } from './topicDraftWriter';

/**
 * Hook pattern performance simulator.
 *
 * The console already runs a real A/B test between two hooks (web/model/abtest.ts)
 * with the repository's statistics. That answers "which of these two, once I have
 * impressions". Before spending impressions, the operator asks the other question:
 * "which *shape* of hook does this topic reward — a question, a number, a reversal,
 * a checklist?"
 *
 * This module answers it as a **heuristic model**, and says so on screen. The base
 * rates below are starting points for a relative comparison; they are not measured
 * engagement numbers, and the output is labelled `휴리스틱 추정` in the UI. The only
 * measured-looking value it produces is the hook length (seconds), which comes from
 * the same speech estimator the renderer uses.
 *
 * The model: start from a base rate per pattern, then apply multipliers for what is
 * actually known about this topic — the category's save/share tendency, whether the
 * topic carries numbers, the topic intent, and whether the hook fits the 3-second
 * window. Every applied multiplier is returned with the row, so the screen can show
 * why one pattern leads instead of presenting a bare percentage.
 */

export const HOOK_PATTERN_IDS = ['question', 'numbers', 'reversal', 'checklist'] as const;
export type HookPatternId = (typeof HOOK_PATTERN_IDS)[number];

export interface HookPatternMeta {
  id: HookPatternId;
  label: string;
  /** Which script angle writes this hook shape */
  angle: AngleId;
  /** What the pattern does for the viewer */
  mechanism: string;
}

export const HOOK_PATTERN_META: Record<HookPatternId, HookPatternMeta> = {
  question: {
    id: 'question',
    label: '질문형',
    angle: 'problem-solve',
    mechanism: '시청자가 겪는 장면을 질문으로 먼저 재현해 3초 유지에 유리합니다.',
  },
  numbers: {
    id: 'numbers',
    label: '숫자형',
    angle: 'numbers',
    mechanism: '결과를 숫자로 먼저 약속해 기대치를 고정합니다. 주제에 숫자가 있을 때 특히 강합니다.',
  },
  reversal: {
    id: 'reversal',
    label: '반전형',
    angle: 'contrarian',
    mechanism: '통념을 부정해 시선을 붙이지만, 저장보다 공유·댓글로 반응이 갈리는 편입니다.',
  },
  checklist: {
    id: 'checklist',
    label: '체크리스트형',
    angle: 'checklist',
    mechanism: '확인할 개수를 먼저 알려 순서를 보장합니다. 저장으로 이어지기 쉬운 형태입니다.',
  },
};

/** 상대 비교용 기준선. 실측 전환율이 아니다 — 화면에도 같은 문구를 적는다. */
const BASE = {
  question: { hold: 0.6, save: 0.042, share: 0.02 },
  numbers: { hold: 0.63, save: 0.047, share: 0.023 },
  reversal: { hold: 0.56, save: 0.036, share: 0.028 },
  checklist: { hold: 0.61, save: 0.055, share: 0.021 },
} as const;

/** 카테고리별 저장 성향 배수. "이런 주제는 이 형태를 저장해 둔다"는 편집 판단을 수치화한 것. */
const CATEGORY_SAVE: Record<TopicCategory, Partial<Record<HookPatternId, number>>> = {
  travel: { checklist: 1.12, question: 1.04, numbers: 0.98 },
  product: { numbers: 1.08, reversal: 1.05, checklist: 0.96 },
  info: { checklist: 1.12, numbers: 1.06, reversal: 0.94 },
  recipe: { checklist: 1.14, numbers: 1.02, reversal: 0.92 },
  home: { checklist: 1.1, reversal: 1.04, numbers: 0.96 },
  beauty: { numbers: 1.06, checklist: 1.06, reversal: 0.98 },
  money: { numbers: 1.1, checklist: 1.04, reversal: 0.96 },
  care: { checklist: 1.08, question: 1.04, numbers: 0.98 },
  work: { checklist: 1.06, numbers: 1.02, reversal: 0.96 },
  daily: { question: 1.06, reversal: 1.02, checklist: 1.0 },
};

/** 카테고리별 공유 성향 배수. */
const CATEGORY_SHARE: Record<TopicCategory, Partial<Record<HookPatternId, number>>> = {
  travel: { question: 1.14, reversal: 1.08, checklist: 0.96 },
  product: { reversal: 1.12, numbers: 1.05, checklist: 0.94 },
  info: { numbers: 1.08, question: 1.04, reversal: 0.98 },
  recipe: { question: 1.06, checklist: 1.06, reversal: 0.96 },
  home: { reversal: 1.1, question: 1.02, checklist: 0.98 },
  beauty: { reversal: 1.06, numbers: 1.02, checklist: 0.98 },
  money: { numbers: 1.08, reversal: 1.02, checklist: 0.96 },
  care: { question: 1.04, checklist: 1.02, reversal: 0.98 },
  work: { numbers: 1.04, reversal: 1.02, question: 0.98 },
  daily: { reversal: 1.08, question: 1.04, checklist: 0.94 },
};

export interface HookPatternScoreInput {
  profile: TopicProfile;
  /** 패턴별로 실제 작성된 훅 문장과 잰 길이(초) */
  hooks: Record<HookPatternId, { text: string; seconds: number }>;
}

export interface HookPatternRow {
  id: HookPatternId;
  label: string;
  angle: AngleId;
  example: string;
  /** 말 속도로 잰 훅 길이(초) — 이 값만 실측이다 */
  hookSeconds: number;
  /** 3초 유지 추정치(0–1) */
  holdRate3s: number;
  /** 저장 전환 추정치(0–1) */
  saveRate: number;
  /** 공유 전환 추정치(0–1) */
  shareRate: number;
  /** 적용된 배수 설명(화면에 그대로 보여 준다) */
  factors: string[];
  /** 이 주제에서의 한 줄 판단 */
  verdict: string;
}

export interface HookPatternEstimate {
  topic: string;
  profile: TopicProfile;
  rows: HookPatternRow[];
  bestSave: HookPatternId;
  bestShare: HookPatternId;
  method: string;
  notes: string[];
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), max);
}

function round3(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

/**
 * 모델 본체. 훅 문장과 길이를 밖에서 받으므로 테스트가 배수를 하나씩 고정할 수 있다.
 */
export function scoreHookPatterns(input: HookPatternScoreInput): HookPatternRow[] {
  const { profile, hooks } = input;
  const hasNumbers = profile.numbers.length > 0;

  const rows = HOOK_PATTERN_IDS.map((id) => {
    const meta = HOOK_PATTERN_META[id];
    const base = BASE[id];
    const factors: string[] = [];
    let hold = base.hold;
    let save = base.save;
    let share = base.share;

    const categorySave = CATEGORY_SAVE[profile.category][id] ?? 1;
    const categoryShare = CATEGORY_SHARE[profile.category][id] ?? 1;
    if (categorySave !== 1) {
      save *= categorySave;
      factors.push(`${profile.categoryLabel} 주제 저장 성향 ×${categorySave.toFixed(2)}`);
    }
    if (categoryShare !== 1) {
      share *= categoryShare;
      factors.push(`공유 성향 ×${categoryShare.toFixed(2)}`);
    }

    if (hasNumbers && id === 'numbers') {
      hold *= 1.06;
      save *= 1.05;
      factors.push(`주제에 숫자(${profile.numbers.slice(0, 2).join(', ')}) 포함 ×1.06`);
    }
    if (profile.intent === 'review' && id === 'numbers') {
      save *= 1.04;
      factors.push('리뷰 주제 숫자 신뢰 ×1.04');
    }
    if (profile.intent === 'checklist' && id === 'checklist') {
      save *= 1.06;
      factors.push('체크리스트 의도 ×1.06');
    }

    const seconds = clamp(hooks[id].seconds, 0, 20);
    if (seconds > 3.0) {
      hold *= 0.92;
      save *= 0.97;
      factors.push(`훅 ${seconds.toFixed(1)}초(3초 초과) ×0.92`);
    }
    if (seconds > 3.5) {
      hold *= 0.9;
      save *= 0.94;
      share *= 0.95;
      factors.push(`훅 3.5초 초과 ×0.90`);
    }

    return {
      id,
      label: meta.label,
      angle: meta.angle,
      example: hooks[id].text,
      hookSeconds: Math.round(seconds * 10) / 10,
      holdRate3s: round3(clamp(hold, 0.3, 0.85)),
      saveRate: round3(clamp(save, 0.005, 0.12)),
      shareRate: round3(clamp(share, 0.002, 0.06)),
      factors,
      verdict: '',
    } satisfies HookPatternRow;
  });

  const bestSave = rows.reduce((best, row) => (row.saveRate > best.saveRate ? row : best), rows[0]!);
  const bestShare = rows.reduce((best, row) => (row.shareRate > best.shareRate ? row : best), rows[0]!);

  return rows.map((row) => ({
    ...row,
    verdict:
      row.id === bestSave.id && row.id === bestShare.id
        ? '저장·공유 모두 우세'
        : row.id === bestSave.id
          ? '저장 우세'
          : row.id === bestShare.id
            ? '공유 우세'
            : '열세',
  }));
}

export interface HookPatternInput {
  topic: string;
  durationSec?: number;
  language?: Language;
  variation?: number;
}

/** 주제에서 네 가지 훅을 실제로 써 보고(엔진 호출) 그 길이로 점수를 낸다. */
export function estimateHookPatterns(input: HookPatternInput): HookPatternEstimate {
  const language = input.language ?? 'ko';
  const topic = input.topic.replace(/\s+/g, ' ').trim();
  const profile = classifyTopic(topic, language);
  const variation = Math.max(0, Math.round(input.variation ?? 0));
  const durationSec = Math.min(60, Math.max(10, input.durationSec ?? 45));

  const hooks = HOOK_PATTERN_IDS.reduce(
    (acc, id) => {
      const drafts = writeTopicDrafts({
        topic,
        durationSec,
        variation,
        angle: HOOK_PATTERN_META[id].angle,
        language,
      }).drafts;
      const text = drafts[0]?.narration ?? topic;
      acc[id] = { text, seconds: estimateSpeechSeconds(text, { language, speed: 1 }) };
      return acc;
    },
    {} as Record<HookPatternId, { text: string; seconds: number }>,
  );

  const rows = scoreHookPatterns({ profile, hooks });
  const bestSave = rows.reduce((best, row) => (row.saveRate > best.saveRate ? row : best), rows[0]!);
  const bestShare = rows.reduce((best, row) => (row.shareRate > best.shareRate ? row : best), rows[0]!);

  const notes = [
    '훅 문장은 같은 주제로 앵글만 바꿔 실제 엔진이 쓴 것입니다. 길이(초)는 자막·음성 추정치와 같은 계산입니다.',
    '저장·공유 전환율은 카테고리 성향과 훅 길이를 반영한 상대 비교용 추정치이며, 실측 데이터가 아닙니다.',
    '실제 전환은 훅 A/B(위 카드)로 표본을 모아 판정하세요. 추정치가 높은 훅부터 실험하는 편이 낭비가 적습니다.',
  ];

  return {
    topic: profile.topic,
    profile,
    rows,
    bestSave: bestSave.id,
    bestShare: bestShare.id,
    method: '휴리스틱 모델 · 상대 비교용 추정(실측 아님)',
    notes,
  };
}
