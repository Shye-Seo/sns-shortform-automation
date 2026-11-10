/**
 * Public API of the shortform engine.
 *
 * The CLI is a thin shell over these exports: everything the CLI does is
 * available to a scheduler, a webhook or a Next.js server action.
 */
export { ScriptEngine, createScriptEngine, planTimeBudget, compressText, buildTimeline, fitDrafts } from './services/scriptEngine';
export type { ScriptModel, ScriptEngineOptions, CraftResult, SceneDraft, TimeBudget } from './services/scriptEngine';

export {
  AudioEngine,
  buildCues,
  buildAss,
  buildSrt,
  buildVtt,
  buildSubtitleBundle,
  buildMixFilter,
  computeDuckingEnvelope,
  sampleEnvelope,
  buildVolumeExpression,
  envelopeToCsv,
} from './services/audioEngine';
export type { VoiceTrack, CueBuildOptions, DuckingInput, AssPlacement } from './services/audioEngine';

export {
  LocalTtsProvider,
  ElevenLabsTtsProvider,
  OpenAiTtsProvider,
  createTtsProvider,
} from './services/tts';
export type { TtsProvider, TtsRequest, TtsResult } from './services/tts';

export {
  buildRenderJob,
  buildVideoFilterGraph,
  buildEncodeArgs,
  planOverlayLayout,
  checkLayoutCollisions,
  computeContentBox,
  renderJob,
  PLATFORM_UI_ZONES,
} from './services/videoCompositor';

export {
  InstagramPublisher,
  YoutubePublisher,
  validateMedia,
  assertPublishable,
  publishPayload,
  buildVideoMetadata,
} from './services/publisher';

export { createApproval, assertApproval, computeContentHash, subjectFromScript } from './services/approval';
export { buildEpisode, loadProject, renderProject } from './pipeline';
export type { Episode, EpisodeArtifacts, BuildEpisodeOptions } from './pipeline';

export * from './types';
