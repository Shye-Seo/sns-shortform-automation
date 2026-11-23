/**
 * 빌린 구조 + 내 채널 정체성 → 기획안.
 *
 * 문장을 새로 지어내지 않는다. 주제 엔진(`writeTopicDrafts`)이 이 주제에 맞춰
 * 쓴 4비트 대본을 그대로 쓰고, 빌려온 구조에서 바꾸는 것은 세 가지다.
 *   - 첫 문장: 참고 영상이 쓴 훅 패턴과 같은 방식으로 다시 연다.
 *   - 마무리: 참고 영상이 요구한 행동(저장·댓글·링크)을 같은 목표로 쓴다.
 *   - 말투: 채널 정체성의 금지 표현을 걷어내고 상투어를 바꾼다.
 *
 * 시간은 `planTimeBudget`·`fitDrafts`·`buildTimeline`이 정한다. 이 파일이 따로
 * 초를 세면 9:16 스튜디오의 자막과 어긋나기 때문이다. 빌린 박자와 계산된 박자가
 * 다르면 숨기지 않고 `beatTable`에 나란히 놓는다.
 */
import { buildCaption, buildTimeline, fitDrafts, planTimeBudget, type SceneDraft } from '../scriptEngine';
import { ScriptRequestSchema, type ScriptRequest } from '../../types/script';
import { writeTopicDrafts } from '../topicDraftWriter';
import { estimateSpeechSeconds } from '../../lib/text';
import type { AngleChoice, AngleId } from '../../types/plan';
import type { CtaGoal, HookType } from '../../types/script';
import { applyVoice, findBanned } from './identity';
import { detectHookPattern } from './reference';
import {
  HOOK_PATTERN_LABEL,
  PLAN_GOAL_LABEL,
  sonderId,
  type BeatComparison,
  type BeatKey,
  type BorrowedStructure,
  type ChannelIdentity,
  type ContentPlan,
  type HookId,
  type HookPattern,
  type PerformanceSummary,
  type PlanGoal,
  type PlanHook,
  type PlanScene,
} from './types';

const BEAT_ORDER: BeatKey[] = ['hook', 'problem', 'solution', 'cta'];
const BEAT_LABEL: Record<BeatKey, string> = {
  hook: '훅',
  problem: '문제',
  solution: '해결',
  cta: '마무리',
};

/** 빌려온 훅 패턴을 주제 엔진의 앵글로 옮긴다. */
const ANGLE_FOR_PATTERN: Record<HookPattern, AngleChoice> = {
  question: 'problem-solve',
  numbers: 'numbers',
  howto: 'checklist',
  contrarian: 'contrarian',
  story: 'before-after',
};

const HOOK_TYPE_FOR_PATTERN: Record<HookPattern, HookType> = {
  question: 'question',
  numbers: 'numbers',
  howto: 'howto',
  contrarian: 'contrarian',
  story: 'shock',
};

const CTA_FOR_GOAL: Record<PlanGoal, CtaGoal> = {
  save: 'save',
  comment: 'comment',
  follow: 'follow',
  link: 'link',
};

const round = (value: number, digits = 1): number => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

export interface PlanInput {
  topic: string;
  identity: ChannelIdentity;
  structure: BorrowedStructure;
  trendId?: string | null;
  trendTitle?: string;
  durationSec?: number;
  goal?: PlanGoal;
  chosenHook?: HookId;
  /** 성과 로그 요약. 어떤 훅을 추천할지 정하는 데만 쓴다. */
  feedback?: PerformanceSummary | null;
  variation?: number;
  source?: ContentPlan['source'];
}

function clampDuration(value: number): number {
  if (!Number.isFinite(value)) return 45;
  return Math.min(60, Math.max(12, Math.round(value)));
}

/** 화면 자막은 한 줄에 들어가야 한다. 18자에서 끊고 말줄임표를 쓰지 않는다. */
export function shortCaption(text: string, maxChars = 24): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= maxChars) return clean;
  const cut = clean.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(' ');
  const base = lastSpace >= maxChars * 0.6 ? cut.slice(0, lastSpace) : cut;
  return base.replace(/[,·]$/, '');
}

/** 첫 문장이 3초를 넘으면 앞 절만 남긴다. 훅은 3초 언저리에서 끝나야 한다. */
export function fitHook(text: string, maxSec = 3.4): string {
  const clean = applyVoice(text).replace(/\s+/g, ' ').trim();
  if (estimateSpeechSeconds(clean, { language: 'ko', speed: 1 }) <= maxSec) return clean;
  const clauses = clean.split(/(?<=[,·])\s+/);
  let kept = '';
  for (const clause of clauses) {
    const next = kept ? `${kept} ${clause}` : clause;
    if (estimateSpeechSeconds(next, { language: 'ko', speed: 1 }) > maxSec && kept) break;
    kept = next;
    if (estimateSpeechSeconds(kept, { language: 'ko', speed: 1 }) > maxSec) break;
  }
  const words = kept.split(' ');
  while (words.length > 2 && estimateSpeechSeconds(words.join(' '), { language: 'ko', speed: 1 }) > maxSec) {
    words.pop();
  }
  const out = words.join(' ').replace(/[,·]$/, '').trim();
  return out.length > 0 ? out : clean;
}

function goalFromStructure(structure: BorrowedStructure): PlanGoal {
  return structure.goal ?? 'save';
}

/**
 * 후킹 3안.
 * 1안은 빌려온 패턴, 2·3안은 같은 주제를 다른 방식으로 연 것이다. 세 안 모두
 * 같은 주제 엔진이 쓰므로 문장 길이와 말투가 제각각이 되지 않는다.
 */
export function buildHooks(
  topic: string,
  structure: BorrowedStructure,
  durationSec: number,
  goal: PlanGoal,
  feedback: PerformanceSummary | null,
  variation: number,
): PlanHook[] {
  const pool: HookPattern[] = [];
  for (const pattern of [structure.hookPattern, 'numbers', 'contrarian', 'question', 'howto', 'story'] as HookPattern[]) {
    if (!pool.includes(pattern)) pool.push(pattern);
  }
  const candidates: Array<{ text: string; pattern: HookPattern }> = [];
  const spare: Array<{ text: string; pattern: HookPattern }> = [];
  const seenTexts = new Set<string>();
  const used = new Set<HookPattern>();

  // 앵글을 돌려 보고, 실제로 나온 문장의 패턴을 읽어 서로 다른 안만 남긴다.
  // 요청한 앵글과 문장이 다를 수 있어(문제제기 앵글이 명령문을 쓰기도 한다)
  // 화면에 적는 패턴은 요청값이 아니라 문장에서 읽은 값이다.
  for (const pattern of pool) {
    const written = writeTopicDrafts({
      topic,
      durationSec,
      variation,
      angle: ANGLE_FOR_PATTERN[pattern],
      ctaGoal: CTA_FOR_GOAL[goal],
    });
    const raw = written.hook || written.drafts[0]?.narration || topic;
    const text = fitHook(raw);
    if (seenTexts.has(text)) continue;
    seenTexts.add(text);
    const detected = detectHookPattern(text);
    if (used.has(detected)) {
      if (spare.length < 2) spare.push({ text, pattern: detected });
      continue;
    }
    used.add(detected);
    candidates.push({ text, pattern: detected });
  }
  // 앵글을 다 돌려도 서로 다른 패턴이 3개가 안 되면 남은 문장으로 채운다.
  const picked = candidates.slice(0, 3);
  for (const item of spare) {
    if (picked.length >= 3) break;
    if (picked.some((candidate) => candidate.text === item.text)) continue;
    picked.push(item);
  }

  return picked.slice(0, 3).map((candidate, index) => {
    const id = (['A', 'B', 'C'] as HookId[])[index] as HookId;
    const { text, pattern } = candidate;
    const performanceRow = feedback?.patternRows.find((row) => row.pattern === pattern);
    let reason: string;
    if (index === 0) {
      reason = `빌려온 영상의 첫 문장은 ${HOOK_PATTERN_LABEL[structure.hookPattern]}이었습니다. 같은 앵글로 열고 소재만 내 주제로 바꿨습니다.`;
    } else if (performanceRow && performanceRow.count > 0) {
      reason = `내 성과 로그에서 ${HOOK_PATTERN_LABEL[pattern]} 훅이 ${performanceRow.count}건 평균 저장률 ${(performanceRow.saveRate * 100).toFixed(1)}%였습니다.`;
    } else {
      reason = `같은 주제를 ${HOOK_PATTERN_LABEL[pattern]}으로 열면 다른 각도가 나옵니다.`;
    }
    return { id, pattern, text, reason };
  });
}

function pickRecommended(hooks: PlanHook[], feedback: PerformanceSummary | null): HookId {
  if (!feedback?.bestPattern) return 'A';
  const match = hooks.find((hook) => hook.pattern === feedback.bestPattern);
  return match?.id ?? 'A';
}

interface BuiltScenes {
  scenes: PlanScene[];
  totalSec: number;
  request: ScriptRequest;
  drafts: SceneDraft[];
}

function buildScenes(
  drafts: SceneDraft[],
  topic: string,
  hookText: string,
  durationSec: number,
  goal: PlanGoal,
  pattern: HookPattern,
): BuiltScenes {
  const prepared: SceneDraft[] = drafts.map((draft, index) => {
    const narration = applyVoice(draft.narration);
    if (index === 0) {
      return { ...draft, narration: hookText, onScreenText: shortCaption(hookText) };
    }
    return { ...draft, narration, onScreenText: draft.onScreenText ?? shortCaption(narration) };
  });

  const request = ScriptRequestSchema.parse({
    topic,
    language: 'ko',
    targetDurationSec: clampDuration(durationSec),
    speed: 1,
    hookType: HOOK_TYPE_FOR_PATTERN[pattern],
    ctaGoal: CTA_FOR_GOAL[goal],
  });
  const budget = planTimeBudget({
    targetDurationSec: request.targetDurationSec,
    language: request.language,
    speed: request.speed,
    sceneCount: prepared.length,
  });
  const fitted = fitDrafts(prepared, request, budget);
  const timeline = buildTimeline(fitted.drafts, request, request.targetDurationSec);

  const scenes: PlanScene[] = timeline.scenes.map((scene) => ({
    beat: scene.beat,
    label: BEAT_LABEL[scene.beat],
    startSec: round(scene.startSec, 2),
    endSec: round(scene.startSec + scene.durationSec, 2),
    narration: scene.narration,
    caption: scene.onScreenText ?? shortCaption(scene.narration),
  }));

  return { scenes, totalSec: round(timeline.totalDurationSec, 1), request, drafts: fitted.drafts };
}

function compareBeats(structure: BorrowedStructure, scenes: PlanScene[], totalSec: number): BeatComparison[] {
  const planSec: Record<BeatKey, number> = { hook: 0, problem: 0, solution: 0, cta: 0 };
  for (const scene of scenes) {
    planSec[scene.beat] += scene.endSec - scene.startSec;
  }
  return BEAT_ORDER.map((beat) => {
    const borrowed = structure.beats.find((item) => item.beat === beat);
    const borrowedSec = borrowed ? round(borrowed.endSec - borrowed.startSec, 1) : 0;
    const seconds = round(planSec[beat], 1);
    return {
      beat,
      label: BEAT_LABEL[beat],
      borrowedRatio: borrowed?.ratio ?? 0,
      planRatio: totalSec > 0 ? round(seconds / totalSec, 3) : 0,
      borrowedSec,
      planSec: seconds,
      deltaSec: round(seconds - borrowedSec, 1),
    };
  });
}

function rhythmNotes(table: BeatComparison[]): string[] {
  const notes: string[] = [];
  for (const row of table) {
    const tolerance = Math.max(1.5, row.borrowedSec * 0.25);
    if (Math.abs(row.deltaSec) < tolerance) continue;
    const direction = row.deltaSec > 0 ? '깁니다' : '짧습니다';
      if (row.beat === 'hook') {
      // 빌린 훅이 4초를 넘는 경우가 있다. 그대로 옮기면 첫 3초에 시선을 잃으므로
      // 이 기획안은 3초 기준으로 줄인다. 줄인 것을 결함으로 적지 않는다.
      notes.push(
        row.planSec <= 3.5 && row.borrowedSec > row.planSec
          ? `훅은 3초 안을 기준으로 줄여 잡았습니다(빌린 구조 ${row.borrowedSec}초 → 이 대본 ${row.planSec}초). 도입이 길면 첫 3초에 시선을 잃습니다.`
          : `훅이 빌린 구조보다 ${Math.abs(row.deltaSec)}초 ${direction}. 첫 자막을 두 줄로 나눠 3초 안에 넘기세요.`,
      );
    } else if (row.beat === 'solution') {
      notes.push(
        `해결 구간이 빌린 구조보다 ${Math.abs(row.deltaSec)}초 ${direction}. 사례를 한 문장 더 넣거나 컷을 하나 늘리면 박자가 맞습니다.`,
      );
    } else if (row.beat === 'cta') {
      notes.push(`마무리가 빌린 구조보다 ${Math.abs(row.deltaSec)}초 ${direction}. 요구는 하나만 남기세요.`);
    } else {
      notes.push(`문제 구간이 빌린 구조보다 ${Math.abs(row.deltaSec)}초 ${direction}. 겪는 장면을 한 컷 더 붙이면 맞습니다.`);
    }
  }
  return notes.slice(0, 3);
}

function hashtagsFor(topic: string, identity: ChannelIdentity, base: string[]): string[] {
  const tagFromHandle = identity.handle.replace(/^@/, '').trim();
  const tags = [...base, tagFromHandle ? `#${tagFromHandle}` : ''].filter((tag) => tag.length > 1);
  if (tags.length === 0) tags.push(`#${topic.replace(/\s+/g, '')}`.slice(0, 20));
  return [...new Set(tags)].slice(0, 8);
}

export interface PlanResult {
  plan: ContentPlan;
  recommended: HookId;
}

/** 기획안 한 장. 같은 입력이면 같은 결과가 나온다(생성 시각과 id 제외). */
export function buildPlan(input: PlanInput): PlanResult {
  const topic = (input.topic ?? '').trim();
  if (topic.length < 2) throw new Error('주제를 두 글자 이상 넣어 주세요');

  const feedback = input.feedback ?? null;
  const goal = input.goal ?? goalFromStructure(input.structure);
  const durationSec = clampDuration(input.durationSec ?? input.structure.durationSec ?? 45);
  const variation = input.variation ?? 0;

  const hooks = buildHooks(topic, input.structure, durationSec, goal, feedback, variation);
  const recommended = pickRecommended(hooks, feedback);
  const chosenHook = input.chosenHook ?? recommended;
  const chosen = hooks.find((hook) => hook.id === chosenHook) ?? (hooks[0] as PlanHook);

  const written = writeTopicDrafts({
    topic,
    durationSec,
    variation,
    angle: ANGLE_FOR_PATTERN[chosen.pattern],
    ctaGoal: CTA_FOR_GOAL[goal],
  });
  const built = buildScenes(written.drafts, topic, chosen.text, durationSec, goal, chosen.pattern);

  const baseTags = hashtagsFor(topic, input.identity, written.hashtags);
  const signature = input.identity.signature[0] ?? '';
  const body = buildCaption(
    built.scenes.map((scene, index) => ({
      id: `p${index + 1}`,
      beat: scene.beat,
      index,
      narration: scene.narration,
      onScreenText: scene.caption,
      emphasis: [],
      startSec: scene.startSec,
      durationSec: Math.max(0.6, scene.endSec - scene.startSec),
      estimatedSpeechSec: Math.max(0, scene.endSec - scene.startSec),
      syllables: 0,
    })),
    built.request,
    baseTags,
  );
  const caption = [body, signature].filter((line) => line.trim().length > 0).join('\n\n');

  const table = compareBeats(input.structure, built.scenes, built.totalSec);
  const hookSec = built.scenes[0] ? round((built.scenes[0].endSec - built.scenes[0].startSec) as number, 1) : 0;
  const bannedHits = findBanned(
    [...built.scenes.map((scene) => scene.narration), caption].join('\n'),
    input.identity.banned,
  );

  const notes: string[] = [];
  notes.push(`마무리 목표는 ${PLAN_GOAL_LABEL[goal]}입니다. 빌린 영상의 마지막 문장이 요구한 행동과 같습니다.`);
  if (built.totalSec > built.request.targetDurationSec + 0.5) {
    notes.push(`대본이 목표 ${built.request.targetDurationSec}초를 ${round(built.totalSec - built.request.targetDurationSec, 1)}초 넘습니다. 해결 구간을 한 문장 줄이세요.`);
  } else if (built.totalSec < built.request.targetDurationSec - 2) {
    notes.push(
      `대본이 목표보다 ${round(built.request.targetDurationSec - built.totalSec, 1)}초 짧습니다. 문장을 더하거나, 남는 시간은 화면 유지로 채우세요.`,
    );
  }
  if (feedback?.notes.length) notes.push(...feedback.notes.slice(0, 2));

  const plan: ContentPlan = {
    id: sonderId('plan'),
    topic,
    identityId: input.identity.id,
    identityName: input.identity.name,
    trendId: input.trendId ?? null,
    trendTitle: input.trendTitle ?? '',
    goal,
    structure: input.structure,
    hooks,
    chosenHook: chosen.id,
    scenes: built.scenes,
    beatTable: table,
    caption,
    hashtags: baseTags,
    checks: { bannedHits, hookSec, totalSec: built.totalSec, rhythmNotes: rhythmNotes(table) },
    notes,
    source: input.source ?? 'rules',
    createdAt: new Date().toISOString(),
  };

  return { plan, recommended };
}

/** 훅을 바꾸면 같은 입력으로 다시 계산한다. 화면에서 3안을 눌렀을 때 쓴다. */
export function switchHook(input: PlanInput, hookId: HookId): PlanResult {
  return buildPlan({ ...input, chosenHook: hookId });
}

/**
 * LLM이 돌려준 대본을 기획안 모양으로 바꾼다. 모델은 훅 3안과 장면 문장만
 * 쓰고, 시간·자막·박자표는 엔진이 계산한다. 모델이 초를 적어 와도 믿지 않는다.
 */
export function planFromModelDrafts(
  input: PlanInput,
  payload: { hooks: Array<{ pattern?: string; text: string }>; scenes: Array<{ beat: string; narration: string }> },
  source: ContentPlan['source'],
): PlanResult {
  const validPatterns: HookPattern[] = ['question', 'numbers', 'howto', 'contrarian', 'story'];
  const hooks: PlanHook[] = payload.hooks
    .filter((hook) => typeof hook.text === 'string' && hook.text.trim().length > 0)
    .slice(0, 3)
    .map((hook, index) => {
      const pattern = validPatterns.includes(hook.pattern as HookPattern)
        ? (hook.pattern as HookPattern)
        : input.structure.hookPattern;
      return {
        id: (['A', 'B', 'C'] as HookId[])[index] as HookId,
        pattern,
        text: fitHook(hook.text),
        reason: `연결한 모델이 ${HOOK_PATTERN_LABEL[pattern]}으로 쓴 안입니다. 문장 길이와 자막은 엔진이 다시 계산했습니다.`,
      };
    });

  if (hooks.length === 0) throw new Error('모델이 훅을 돌려주지 않았습니다');

  const goal = input.goal ?? goalFromStructure(input.structure);
  const durationSec = clampDuration(input.durationSec ?? input.structure.durationSec ?? 45);
  const chosenHook = input.chosenHook ?? 'A';
  const chosen = hooks.find((hook) => hook.id === chosenHook) ?? (hooks[0] as PlanHook);

  const wantBeats: Record<string, BeatKey> = { hook: 'hook', problem: 'problem', solution: 'solution', cta: 'cta' };
  const modelDrafts: SceneDraft[] = payload.scenes
    .map((scene, index) => ({
      beat: wantBeats[scene.beat] ?? (index === 0 ? 'hook' : index === payload.scenes.length - 1 ? 'cta' : 'solution'),
      narration: String(scene.narration ?? '').trim(),
    }))
    .filter((draft) => draft.narration.length > 0)
    .slice(0, 8);

  const hasAllBeats = BEAT_ORDER.every((beat) => modelDrafts.some((draft) => draft.beat === beat));
  const drafts: SceneDraft[] = hasAllBeats
    ? modelDrafts
    : writeTopicDrafts({
        topic: input.topic,
        durationSec,
        variation: input.variation ?? 0,
        angle: ANGLE_FOR_PATTERN[chosen.pattern],
        ctaGoal: CTA_FOR_GOAL[goal],
      }).drafts;

  const built = buildScenes(drafts, input.topic, chosen.text, durationSec, goal, chosen.pattern);
  const baseTags = hashtagsFor(input.topic, input.identity, [`#${input.topic.replace(/\s+/g, '')}`.slice(0, 20)]);
  const signature = input.identity.signature[0] ?? '';
  const caption = [buildCaption(built.scenes.map((scene, index) => ({
    id: `m${index + 1}`,
    beat: scene.beat,
    index,
    narration: scene.narration,
    onScreenText: scene.caption,
    emphasis: [],
    startSec: scene.startSec,
    durationSec: Math.max(0.6, scene.endSec - scene.startSec),
    estimatedSpeechSec: Math.max(0, scene.endSec - scene.startSec),
    syllables: 0,
  })), built.request, baseTags), signature]
    .filter((line) => line.trim().length > 0)
    .join('\n\n');

  const table = compareBeats(input.structure, built.scenes, built.totalSec);
  const hookSec = built.scenes[0] ? round((built.scenes[0].endSec - built.scenes[0].startSec) as number, 1) : 0;

  return {
    plan: {
      id: sonderId('plan'),
      topic: input.topic.trim(),
      identityId: input.identity.id,
      identityName: input.identity.name,
      trendId: input.trendId ?? null,
      trendTitle: input.trendTitle ?? '',
      goal,
      structure: input.structure,
      hooks,
      chosenHook: chosen.id,
      scenes: built.scenes,
      beatTable: table,
      caption,
      hashtags: baseTags,
      checks: {
        bannedHits: findBanned([...built.scenes.map((scene) => scene.narration), caption].join('\n'), input.identity.banned),
        hookSec,
        totalSec: built.totalSec,
        rhythmNotes: rhythmNotes(table),
      },
      notes: [
        `마무리 목표는 ${PLAN_GOAL_LABEL[goal]}입니다.`,
        hasAllBeats ? '모델이 쓴 장면을 그대로 썼고, 시간은 엔진이 다시 계산했습니다.' : '모델이 네 박자를 다 주지 않아 내장 엔진 대본으로 채웠습니다.',
      ],
      source,
      createdAt: new Date().toISOString(),
    },
    recommended: 'A',
  };
}

/** 기획안을 그대로 복사해 갈 수 있는 문서 형태. */
export function renderPlanDoc(plan: ContentPlan): string {
  const lines = [
    `# ${plan.topic}`,
    '',
    `- 채널: ${plan.identityName}`,
    plan.trendTitle ? `- 빌린 구조: ${plan.trendTitle}` : '- 빌린 구조: 없음',
    `- 마무리: ${PLAN_GOAL_LABEL[plan.goal]}`,
    `- 길이: ${plan.checks.totalSec}초 · 훅 ${plan.checks.hookSec}초`,
    '',
    '## 후킹 3안',
    ...plan.hooks.map((hook) => `- ${hook.id}. [${HOOK_PATTERN_LABEL[hook.pattern]}] ${hook.text}`),
    '',
    '## 컷별 자막',
    '| 구간 | 박자 | 자막 | 내레이션 |',
    '| --- | --- | --- | --- |',
    ...plan.scenes.map(
      (scene) => `| ${scene.startSec}–${scene.endSec}s | ${scene.label} | ${scene.caption} | ${scene.narration} |`,
    ),
    '',
    '## 박자표',
    '| 박자 | 빌린 구조 | 이 기획안 | 차이 |',
    '| --- | --- | --- | --- |',
    ...plan.beatTable.map(
      (row) => `| ${row.label} | ${row.borrowedSec}s | ${row.planSec}s | ${row.deltaSec > 0 ? '+' : ''}${row.deltaSec}s |`,
    ),
    '',
    '## 캡션',
    plan.caption,
  ];
  if (plan.notes.length > 0) lines.push('', '## 메모', ...plan.notes.map((note) => `- ${note}`));
  return `${lines.join('\n')}\n`;
}

/**
 * 서버에서 연결한 모델에 보내는 지시문. 모델은 훅 3안과 장면 문장만 쓰고,
 * 시간·자막·박자는 엔진이 계산한다고 분명히 적는다. 모델이 초를 지어내면
 * 9:16 스튜디오의 자막과 어긋나기 때문이다.
 */
export function buildPlanPrompt(input: PlanInput): { system: string; user: string } {
  const identity = input.identity;
  const structure = input.structure;
  const durationSec = clampDuration(input.durationSec ?? structure.durationSec ?? 45);
  const goal = input.goal ?? goalFromStructure(structure);
  const beats = structure.beats
    .map((beat) => `- ${BEAT_LABEL[beat.beat]} ${beat.startSec}~${beat.endSec}초 (${Math.round(beat.ratio * 100)}%)`)
    .join('\n');

  const system = [
    '한국어 숏폼 대본을 쓰는 카피라이터입니다.',
    '결과는 설명 없이 JSON 하나로만 답합니다.',
    '과장 형용사, 감탄사, AI 티 나는 상투어를 쓰지 않습니다.',
  ].join(' ');

  const user = [
    `주제: ${input.topic}`,
    `영상 길이: ${durationSec}초`,
    '',
    '[채널 정체성]',
    `- 이름: ${identity.name}`,
    `- 한 줄 소개: ${identity.posture}`,
    `- 타깃: ${identity.audience}`,
    `- 말투: ${identity.voice}`,
    `- 고정 강점: ${identity.strengths.join(', ') || '없음'}`,
    `- 쓰지 않는 표현: ${identity.banned.join(', ') || '없음'}`,
    '',
    '[빌려온 구조]',
    `- 첫 문장 패턴: ${HOOK_PATTERN_LABEL[structure.hookPattern]}`,
    `- 예시 첫 문장: ${structure.hookLine}`,
    beats,
    `- 마지막 요구: ${PLAN_GOAL_LABEL[goal]}`,
    '',
    '[쓸 것]',
    `1) 훅 3안. 서로 다른 패턴(question, numbers, howto, contrarian, story)으로. 각 문장은 16음절 이내(약 3초).`,
    `2) 장면 4개 이상. beat는 hook, problem, solution, cta 중 하나. solution이 가장 깁니다.`,
    '3) 각 나레이션은 실제로 말하는 한두 문장. 숫자나 구체적인 상황을 하나씩 넣습니다.',
    '4) 금지 표현은 쓰지 않습니다.',
    '',
    '응답 형식:',
    '{"hooks":[{"pattern":"question","text":"..."}],"scenes":[{"beat":"hook","narration":"..."}]}',
  ].join('\n');

  return { system, user };
}

/** 모델 응답에서 훅·장면만 꺼낸다. 모양이 다르면 null을 돌려 규칙 기반으로 되돌린다. */
export function readModelPlanPayload(value: unknown): {
  hooks: Array<{ pattern?: string; text: string }>;
  scenes: Array<{ beat: string; narration: string }>;
} | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const hooks = Array.isArray(record.hooks)
    ? record.hooks
        .map((hook) => {
          if (typeof hook === 'string') return { text: hook };
          if (typeof hook !== 'object' || hook === null) return null;
          const item = hook as Record<string, unknown>;
          return {
            pattern: typeof item.pattern === 'string' ? item.pattern : undefined,
            text: typeof item.text === 'string' ? item.text : '',
          };
        })
        .filter((hook): hook is { pattern?: string; text: string } => hook !== null && hook.text.trim().length > 0)
    : [];
  const scenes = Array.isArray(record.scenes)
    ? record.scenes
        .map((scene) => {
          if (typeof scene !== 'object' || scene === null) return null;
          const item = scene as Record<string, unknown>;
          return {
            beat: typeof item.beat === 'string' ? item.beat : 'solution',
            narration: typeof item.narration === 'string' ? item.narration : '',
          };
        })
        .filter((scene): scene is { beat: string; narration: string } => scene !== null && scene.narration.trim().length > 0)
    : [];
  if (hooks.length === 0) return null;
  return { hooks, scenes };
}

/** 화면에서 앵글 이름을 보여 줄 때 쓴다. */
export const ANGLE_LABEL: Record<AngleId, string> = {
  'problem-solve': '문제 제기',
  numbers: '숫자 비교',
  checklist: '체크리스트',
  'before-after': '전후 비교',
  contrarian: '역발상',
};
