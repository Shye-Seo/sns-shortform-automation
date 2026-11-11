import { RenderJobPayloadSchema, type QueueJob, type RenderChunk, type RenderJobPayload, type RenderJobResult } from '../../types/queue';
import { ShortformError } from '../errors';
import type { JobHandler } from './workerPool';

export interface SimulatedRenderOptions {
  /** Simulated compute time for one ordinary chunk (the flush chunk costs 1.35×). */
  chunkMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Return a message to fail the attempt; null to proceed. Injected by tests. */
  failOn?: (job: QueueJob, attempt: number) => string | null;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Split a timeline into encoder chunks. The last chunk is heavier: it flushes
 * the muxer, rewrites the moov atom for `+faststart`, and uploads the header,
 * so weighting it as an equal share under-estimates the tail latency.
 */
export function planRenderChunks(durationSec: number, chunkCount: number, fps = 30): RenderChunk[] {
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    throw new ShortformError('durationSec must be positive', { code: 'VALIDATION' });
  }
  const count = Math.max(1, Math.min(64, Math.floor(chunkCount)));
  const span = durationSec / count;
  const totalFrames = Math.round(durationSec * fps);
  const frameAt = (seconds: number): number => Math.round(seconds * fps);
  return Array.from({ length: count }, (_, index) => {
    const startSec = Math.round(span * index * 1_000) / 1_000;
    const endSec = index === count - 1 ? durationSec : Math.round(span * (index + 1) * 1_000) / 1_000;
    // Boundary rounding, not per-chunk rounding: the frame counts then sum to
    // round(duration × fps) exactly, which is what the muxer expects.
    const frames =
      index === count - 1
        ? Math.max(1, totalFrames - frameAt(startSec))
        : Math.max(1, frameAt(endSec) - frameAt(startSec));
    return {
      index,
      startSec,
      endSec,
      frames,
      weight: index === count - 1 && count > 1 ? 1.35 : 1,
    };
  });
}

export function totalChunkWeight(chunks: RenderChunk[]): number {
  return chunks.reduce((sum, chunk) => sum + chunk.weight, 0);
}

function parsePayload(job: QueueJob): RenderJobPayload {
  const parsed = RenderJobPayloadSchema.safeParse(job.payload);
  if (!parsed.success) {
    // A malformed payload will never succeed on retry — fail it fast instead
    // of burning three attempts and a worker slot on the same zod error.
    throw new ShortformError('render job payload is invalid', {
      code: 'VALIDATION',
      retryable: false,
      details: { issues: parsed.error.issues.map((issue) => issue.path.join('.') + ': ' + issue.message) },
    });
  }
  return parsed.data;
}

/**
 * A render handler that behaves like the real encoder: it takes time per
 * chunk, streams progress, and can fail an attempt on demand. The CLI and the
 * tests use the same handler, so the queue's retry policy is exercised against
 * the same code path as production.
 */
export function createSimulatedRenderHandler(options: SimulatedRenderOptions = {}): JobHandler<RenderJobResult> {
  const sleep = options.sleep ?? defaultSleep;
  const chunkMs = options.chunkMs ?? 60;
  return async ({ job, attempt, reportProgress }) => {
    const payload = parsePayload(job);
    const chunks = planRenderChunks(payload.durationSec, payload.chunkCount);
    const failure = options.failOn?.(job, attempt) ?? null;
    if (failure) {
      throw new ShortformError(failure, { code: 'MEDIA', retryable: true, details: { attempt } });
    }

    for (const chunk of chunks) {
      await sleep(chunkMs * chunk.weight);
      const percent = ((chunk.index + 1) / chunks.length) * 100;
      await reportProgress(percent);
    }

    return {
      projectId: payload.projectId,
      outputPath: payload.outputPath ?? `.work/${payload.projectId}/render.mp4`,
      chunks: chunks.length,
      encodedSec: payload.durationSec,
      simulated: true,
    };
  };
}

export interface ProjectRenderResult {
  status?: string;
  output?: { path?: string };
  warnings?: string[];
}

/**
 * Bridge from the queue to the real pipeline. `render` is injected (the CLI
 * passes `renderProject`) so the queue never imports ffmpeg code and tests can
 * assert the wiring without a binary.
 */
export function createProjectRenderHandler(options: {
  render: (projectDir: string, config: { execute: boolean }) => Promise<ProjectRenderResult>;
  chunkCount?: number;
  /** Default true. `false` keeps the queue path usable without ffmpeg (plan only). */
  execute?: boolean;
  onStart?: (projectDir: string) => Promise<void> | void;
}): JobHandler<RenderJobResult> {
  return async ({ job, reportProgress }) => {
    const payload = parsePayload(job);
    const outputPath = payload.outputPath ?? `.work/${payload.projectId}/render.mp4`;
    const chunks = planRenderChunks(payload.durationSec, payload.chunkCount ?? options.chunkCount ?? 4);
    await options.onStart?.(payload.projectId);
    await reportProgress(5);
    const result = await options.render(payload.projectId, { execute: options.execute ?? true });
    if (result.status === 'failed') {
      throw new ShortformError(`render failed: ${(result.warnings ?? []).slice(-2).join(' / ')}`, {
        code: 'MEDIA',
        retryable: true,
      });
    }
    await reportProgress(100);
    return {
      projectId: payload.projectId,
      outputPath: result.output?.path ?? outputPath,
      chunks: chunks.length,
      encodedSec: payload.durationSec,
      simulated: false,
    };
  };
}
