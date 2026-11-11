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

/* Distributed render queue */
export {
  JobQueue,
  InMemoryQueueStore,
  FileQueueStore,
  WorkerPool,
  BinaryHeap,
  computeRetryDelay,
  maxRetryBudgetMs,
  planRenderChunks,
  totalChunkWeight,
  createSimulatedRenderHandler,
  createProjectRenderHandler,
} from './lib/queue';
export type {
  QueueStore,
  JobQueueOptions,
  FailOptions,
  WorkerContext,
  JobHandler,
  WorkerLoad,
  WorkerPoolOptions,
  PoolSummary,
  SimulatedRenderOptions,
  ProjectRenderResult,
} from './lib/queue';

/* Redis queue adapter: multi-node atomic claim + driver selection */
export {
  RedisQueueStore,
  redisQueueKeys,
  createQueueStore,
  resolveQueueDriver,
  isReservableStore,
  QUEUE_DRIVERS,
  JOB_STATES,
} from './queue/redisAdapter';
export type {
  RedisCommand,
  RedisTransactionClient,
  RedisQueueStoreOptions,
  RedisQueueKeys,
  ReservableQueueStore,
  ReserveOptions,
  QueueDriver,
  CreateQueueStoreOptions,
} from './queue/redisAdapter';

/* Rate limiting, tenant isolation and OAuth rotation */
export {
  RateLimitBucket,
  DailyQuota,
  TenantRegistry,
  PROVIDER_PROFILES,
  PLAN_HEADROOM,
  OAuthTokenRotator,
  OAuthRefreshError,
  PROVIDER_OF,
  planPublishSlots,
  gapStatistics,
  jitteredDelay,
} from './lib/rateLimit';
export type {
  RateLimitBucketOptions,
  BucketSnapshot,
  ConsumeDecision,
  ProviderId,
  TenantPlan,
  TenantLimitView,
  LimitDecision,
  TokenLease,
  CredentialSnapshot,
  TokenRefresher,
  PublishSlot,
  GapStatistics,
} from './lib/rateLimit';

/* Hook A/B testing and telemetry */
export {
  HOOK_TEMPLATES,
  HOOK_SECONDS_CEILING,
  generateHookVariants,
  assignVariant,
  bucketOf,
  assignmentSpread,
  TelemetryIngestor,
  deriveMetrics,
  evaluateExperiment,
  twoProportionZTest,
  wilsonInterval,
  requiredSampleSize,
  normalCdf,
  normalQuantile,
  erf,
  HookFeedbackLoop,
} from './lib/telemetry';
export type {
  HookTemplate,
  GenerateHooksOptions,
  IngestResult,
  EvaluateOptions,
  ProportionTest,
  AngleStats,
  HookFeedbackOptions,
} from './lib/telemetry';

/* Queue time-series metrics (throughput, failure rate, rate-limit tokens) */
export {
  MetricsTimeSeries,
  buildMetricsChart,
  downsample,
  rateLimitReadings,
  renderMetricsTimeSeriesSvg,
  sparkline,
} from './studio/metricsTimeSeries';
export type {
  MetricsChart,
  MetricsChartOptions,
  MetricsPoint,
  MetricsSampleInput,
  MetricsSeriesView,
  MetricsTimeSeriesOptions,
  RateLimitReading,
} from './studio/metricsTimeSeries';

/* B2B studio console and read API */
export { StudioConsole, StudioApi, createDemoStudio, variantById } from './services/studio';
export type {
  StudioSnapshot,
  StudioQueueView,
  StudioWorkerView,
  StudioExperimentView,
  StudioDlqEntry,
  StudioExperimentConfig,
  StudioApiRequest,
  StudioApiResponse,
  DemoStudio,
} from './services/studio';

export * from './types';
