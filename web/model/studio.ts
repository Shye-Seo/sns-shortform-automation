import { buildCues, computeDuckingEnvelope, sampleEnvelope } from '../../src/services/audioEngine';
import {
  buildTimeline,
  draftScenesHeuristic,
  fitDrafts,
  planTimeBudget,
  type SceneDraft,
  type TimeBudget,
} from '../../src/services/scriptEngine';
import { estimateAlignmentFor } from '../../src/services/tts';
import { checkLayoutCollisions, planOverlayLayout } from '../../src/services/videoCompositor';
import { estimateSpeechSeconds, measureTextPx } from '../../src/lib/text';
import { round } from '../../src/lib/ids';
import {
  ScriptRequestSchema,
  type Beat,
  type CompressionReport,
  type Language,
  type Scene,
  type ScriptRequest,
} from '../../src/types/script';
import type { Cue, DuckingEnvelope, WordTiming } from '../../src/types/audio';
import type { CollisionReport, OverlayLayout } from '../../src/types/render';

/**
 * The studio preview is a *read model* over the real engine.
 *
 * Nothing here decides how long a line takes, where a caption goes or how far
 * the music ducks — `planTimeBudget`, `fitDrafts`, `buildTimeline`,
 * `estimateAlignmentFor`, `computeDuckingEnvelope` and `buildCues` do. This file
 * only assembles their output into the shapes a browser can draw, so the demo
 * and the renderer cannot disagree about a single word position.
 */

export interface StudioInput {
  topic: string;
  durationSec: number;
  speed: number;
  language: Language;
  drafts: SceneDraft[];
  /** Run the engine's compression passes when a line overruns its beat budget. */
  compress: boolean;
}

export interface StudioModel {
  request: ScriptRequest;
  budget: TimeBudget;
  scenes: Scene[];
  compression: CompressionReport;
  totalDurationSec: number;
  speechSec: number;
  pauseSec: number;
  /** Absolute word timings across the whole timeline. */
  words: WordTiming[];
  cues: Cue[];
  envelope: DuckingEnvelope;
  layout: OverlayLayout;
  collisions: CollisionReport;
  /** Seconds the timeline asks for beyond the picked target duration. */
  overrunSec: number;
  /** The longest caption card, in pixels, after wrapping at the real font size. */
  widestCueWidthPx: number;
}

export function makeRequest(topic: string, durationSec: number, speed: number, language: Language = 'ko'): ScriptRequest {
  return ScriptRequestSchema.parse({
    topic: topic.trim() === '' ? '부산 신혼집 주방 수납' : topic,
    language,
    targetDurationSec: Math.min(60, Math.max(10, durationSec)),
    speed: Math.min(1.3, Math.max(0.8, speed)),
    hookType: 'question',
    ctaGoal: 'comment',
  });
}

/** Engine draft for a topic: one hook, one problem, N solution steps, one CTA. */
export function draftBeatScene(topic: string, durationSec: number): SceneDraft[] {
  const request = makeRequest(topic, durationSec, 1);
  return draftScenesHeuristic({ request, keywords: [] }, { targetDurationSec: durationSec });
}

function measureAll(drafts: SceneDraft[], request: ScriptRequest): number {
  return round(
    drafts.reduce(
      (sum, draft) => sum + estimateSpeechSeconds(draft.narration, { language: request.language, speed: request.speed }),
      0,
    ),
    3,
  );
}

export function buildStudioModel(input: StudioInput): StudioModel {
  const request = makeRequest(input.topic, input.durationSec, input.speed, input.language);
  const drafts = input.drafts.length >= 4 ? input.drafts : draftBeatScene(input.topic, input.durationSec);
  const budget = planTimeBudget({
    targetDurationSec: request.targetDurationSec,
    language: request.language,
    speed: request.speed,
    sceneCount: drafts.length,
  });

  let working = drafts;
  let compression: CompressionReport;

  if (input.compress) {
    const fitted = fitDrafts(drafts, request, budget);
    working = fitted.drafts;
    compression = fitted.compression;
  } else {
    const requestedSec = measureAll(drafts, request);
    compression = {
      applied: false,
      requestedSec,
      capacitySec: round(budget.speechBudgetSec, 2),
      savedSec: 0,
      passes: [],
    };
  }

  const timeline = buildTimeline(working, request, request.targetDurationSec);

  const words: WordTiming[] = [];
  for (const scene of timeline.scenes) {
    if (scene.estimatedSpeechSec <= 0 || scene.narration.trim() === '') continue;
    const sceneWords = estimateAlignmentFor(
      scene.narration,
      scene.estimatedSpeechSec,
      request.language,
      scene.id,
    );
    for (const word of sceneWords) {
      words.push({
        ...word,
        index: words.length,
        startSec: round(scene.startSec + word.startSec, 3),
        endSec: round(scene.startSec + word.endSec, 3),
      });
    }
  }

  // Speech segments per scene, so a pause between two lines releases the duck.
  const segments = timeline.scenes
    .map((scene) => {
      const sceneWords = words.filter((word) => word.sceneId === scene.id);
      if (sceneWords.length === 0) return null;
      return {
        startSec: sceneWords[0]!.startSec,
        endSec: sceneWords[sceneWords.length - 1]!.endSec,
      };
    })
    .filter((segment): segment is { startSec: number; endSec: number } => segment !== null);

  const envelope = computeDuckingEnvelope({ segments, durationSec: timeline.totalDurationSec });
  // The renderer wraps cues to the caption box width (see pipeline.ts), so the
  // preview must wrap at the same number or it draws lines the render never has.
  const layout = planOverlayLayout('instagram-reels', {
    badgeText: 'KITCHEN 3평',
    captionLines: 2,
  });
  const cues = buildCues(words, { maxWidthPx: layout.caption.w });
  const collisions = checkLayoutCollisions(layout, 'instagram-reels');

  // Widest line at the real font size: the number that decides whether a cue
  // fits the safe area on a phone, not a character count.
  const widestCueWidthPx = cues.reduce(
    (widest, cue) =>
      cue.lines.reduce(
        (inner, line) => Math.max(inner, measureTextPx(line, layout.subtitleStyle.fontSizePx)),
        widest,
      ),
    0,
  );

  return {
    request,
    budget,
    scenes: timeline.scenes,
    compression,
    totalDurationSec: timeline.totalDurationSec,
    speechSec: timeline.speechSec,
    pauseSec: timeline.pauseSec,
    words,
    cues,
    envelope,
    layout,
    collisions,
    overrunSec: round(Math.max(0, timeline.totalDurationSec - request.targetDurationSec), 2),
    widestCueWidthPx: Math.round(widestCueWidthPx),
  };
}

export function cueAt(model: StudioModel, tSec: number): Cue | null {
  for (const cue of model.cues) {
    if (tSec >= cue.startSec && tSec < cue.endSec) return cue;
  }
  return null;
}

export function sceneAt(model: StudioModel, tSec: number): Scene | null {
  for (const scene of model.scenes) {
    if (tSec >= scene.startSec && tSec < scene.startSec + scene.durationSec) return scene;
  }
  return model.scenes[0] ?? null;
}

/** Music gain (0–1) at an arbitrary time — the same function the renderer samples. */
export function gainAt(model: StudioModel, tSec: number): number {
  return sampleEnvelope(model.envelope, tSec);
}

export const BEAT_LABEL: Record<Beat, string> = {
  hook: '훅',
  problem: '문제',
  solution: '해결',
  cta: 'CTA',
};

export const BEAT_HINT: Record<Beat, string> = {
  hook: '첫 3.5초. 스크롤을 멈추게 하는 한 문장',
  problem: '시청자가 겪는 구체적인 지점',
  solution: '실행 가능한 단계. 가장 긴 구간',
  cta: '저장·댓글·링크 중 하나만',
};
