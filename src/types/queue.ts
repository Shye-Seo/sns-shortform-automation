import { z } from 'zod';

/**
 * The render queue is the part of the platform that has to survive a worker
 * being killed mid-encode. Every state below is a durable row, not a variable
 * in a function: `waiting → delayed → active → completed | failed → dlq`.
 *
 * `failed` is terminal only for a non-retryable error (bad media, revoked
 * token); retryable errors go back to `delayed` with the attempt counter kept.
 */
export const JobStateSchema = z.enum([
  'waiting',
  'delayed',
  'active',
  'completed',
  'failed',
  'dlq',
]);
export type JobState = z.infer<typeof JobStateSchema>;

export const JobKindSchema = z.enum(['render', 'publish', 'telemetry', 'maintenance']);
export type JobKind = z.infer<typeof JobKindSchema>;

/** 0 = bulk backfill, 9 = a paying tenant's scheduled slot. Higher runs first. */
export const JobPrioritySchema = z.number().int().min(0).max(9);
export type JobPriority = z.infer<typeof JobPrioritySchema>;

export const RetryPolicySchema = z.object({
  /** Total attempts, counting the first one. 3 means one run and two retries. */
  maxAttempts: z.number().int().min(1).max(10).default(3),
  baseDelayMs: z.number().int().min(0).default(1_000),
  maxDelayMs: z.number().int().min(0).default(30_000),
  /**
   * 0 = deterministic 1s/2s/4s, 1 = full jitter (random within the window).
   * Production uses 0.5: enough spread to break a retry stampede, still
   * recognisable in a log.
   */
  jitterRatio: z.number().min(0).max(1).default(0),
});
export type RetryPolicy = z.infer<typeof RetryPolicySchema>;

export const RenderJobPayloadSchema = z.object({
  projectId: z.string().min(1),
  platform: z.enum(['instagram-reels', 'youtube-shorts']),
  durationSec: z.number().positive().max(600),
  chunkCount: z.number().int().min(1).max(64).default(4),
  outputPath: z.string().optional(),
});
export type RenderJobPayload = z.infer<typeof RenderJobPayloadSchema>;

export const JobTransitionSchema = z.object({
  from: JobStateSchema.nullable(),
  to: JobStateSchema,
  at: z.string().datetime(),
  reason: z.string().max(500).optional(),
});
export type JobTransition = z.infer<typeof JobTransitionSchema>;

export const QueueJobSchema = z.object({
  id: z.string().min(1),
  /** Owning tenant. Every read is scoped by it; a queue is multi-tenant. */
  tenantId: z.string().min(1),
  name: z.string().min(1).max(200),
  kind: JobKindSchema.default('render'),
  state: JobStateSchema,
  priority: JobPrioritySchema.default(5),
  payload: z.record(z.unknown()).default({}),
  /** Number of times the job has been started. `maxAttempts` bounds it. */
  attempts: z.number().int().min(0).default(0),
  maxAttempts: z.number().int().min(1).default(3),
  /** 0–100, monotonic. A progress event that would move it backwards is dropped. */
  progress: z.number().min(0).max(100).default(0),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  /** Earliest moment the scheduler may run it (delayed retries, scheduled work). */
  availableAt: z.string().datetime(),
  startedAt: z.string().datetime().nullable().default(null),
  finishedAt: z.string().datetime().nullable().default(null),
  /** Lease expiry. A job still `active` past this is considered stalled. */
  leaseExpiresAt: z.string().datetime().nullable().default(null),
  workerId: z.string().nullable().default(null),
  dedupeKey: z.string().max(200).nullable().default(null),
  lastError: z.string().max(2_000).nullable().default(null),
  result: z.unknown().nullable().default(null),
  transitions: z.array(JobTransitionSchema).default([]),
});
export type QueueJob = z.infer<typeof QueueJobSchema>;

export const EnqueueInputSchema = z.object({
  tenantId: z.string().min(1),
  name: z.string().min(1).max(200),
  kind: JobKindSchema.default('render'),
  priority: JobPrioritySchema.default(5),
  payload: z.record(z.unknown()).default({}),
  maxAttempts: z.number().int().min(1).max(10).optional(),
  delayMs: z.number().int().min(0).optional(),
  /**
   * Idempotency key. A duplicate enqueue while a job with the same key is
   * live returns the live job instead of rendering the same video twice.
   */
  dedupeKey: z.string().max(200).optional(),
});
export type EnqueueInput = z.input<typeof EnqueueInputSchema>;

export const QueueCountsSchema = z.object({
  waiting: z.number().int().min(0),
  delayed: z.number().int().min(0),
  active: z.number().int().min(0),
  completed: z.number().int().min(0),
  failed: z.number().int().min(0),
  dlq: z.number().int().min(0),
});
export type QueueCounts = z.infer<typeof QueueCountsSchema>;

export const QueueStatsSchema = z.object({
  counts: QueueCountsSchema,
  total: z.number().int().min(0),
  /** Completed / (completed + failed + dlq), 0–1. */
  successRate: z.number().min(0).max(1),
  /** Mean wall-clock time of completed jobs, in ms. */
  meanLatencyMs: z.number().min(0),
  /** p95 latency of completed jobs, in ms. */
  p95LatencyMs: z.number().min(0),
  oldestWaitingAgeMs: z.number().min(0),
  retries: z.number().int().min(0),
});
export type QueueStats = z.infer<typeof QueueStatsSchema>;

export type JobEvent =
  | { type: 'enqueued'; at: string; job: QueueJob }
  | { type: 'started'; at: string; job: QueueJob }
  | { type: 'progress'; at: string; job: QueueJob; progress: number }
  | { type: 'retried'; at: string; job: QueueJob; delayMs: number; attempt: number }
  | { type: 'completed'; at: string; job: QueueJob }
  | { type: 'failed'; at: string; job: QueueJob; error: string; willRetry: boolean }
  | { type: 'dlq'; at: string; job: QueueJob; reason: string }
  | { type: 'replayed'; at: string; job: QueueJob }
  | { type: 'discarded'; at: string; job: QueueJob; reason: string }
  | { type: 'stalled'; at: string; job: QueueJob }
  | { type: 'deduped'; at: string; job: QueueJob };

export interface RenderChunk {
  index: number;
  startSec: number;
  endSec: number;
  frames: number;
  /** Share of the wall-clock cost; the last chunk carries the encoder flush. */
  weight: number;
}

export interface RenderJobResult {
  projectId: string;
  outputPath: string;
  chunks: number;
  encodedSec: number;
  simulated: boolean;
}
