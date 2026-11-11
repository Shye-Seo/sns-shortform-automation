import { describe, expect, it } from 'vitest';
import { JobQueue, type JobQueueOptions } from '../src/lib/queue/jobQueue';
import { WorkerPool } from '../src/lib/queue/workerPool';
import { createSimulatedRenderHandler, createProjectRenderHandler, planRenderChunks } from '../src/lib/queue/renderJob';
import { ShortformError } from '../src/lib/errors';
import type { RenderJobResult } from '../src/types/queue';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function queueWithRetry(retry: Partial<JobQueueOptions> = {}) {
  return new JobQueue({
    retry: { baseDelayMs: 5, maxDelayMs: 20, jitterRatio: 0, maxAttempts: 3 },
    leaseTimeoutMs: 5_000,
    ...retry,
  });
}

async function enqueueRenderJobs(queue: JobQueue, count: number, tenantId = 't1') {
  const jobs = [];
  for (let index = 0; index < count; index += 1) {
    jobs.push(
      await queue.enqueue({
        tenantId,
        name: `render-${index}`,
        payload: { projectId: `proj-${index}`, platform: 'instagram-reels', durationSec: 30, chunkCount: 3 },
      }),
    );
  }
  return jobs;
}

describe('worker pool', () => {
  it('drains the whole backlog and reports a summary', async () => {
    const queue = queueWithRetry();
    await enqueueRenderJobs(queue, 6);
    const pool = new WorkerPool({
      queue,
      size: 3,
      handler: createSimulatedRenderHandler({ chunkMs: 1, sleep }),
    });
    const summary = await pool.drain();
    expect(summary.processed).toBe(6);
    expect(summary.succeeded).toBe(6);
    expect(summary.failed).toBe(0);
    expect((await queue.counts()).completed).toBe(6);
    expect((await queue.counts()).waiting).toBe(0);
  });

  it('never exceeds the configured concurrency', async () => {
    const queue = queueWithRetry();
    await enqueueRenderJobs(queue, 12);
    let inFlight = 0;
    let observedMax = 0;
    const pool = new WorkerPool({
      queue,
      size: 3,
      handler: async () => {
        inFlight += 1;
        observedMax = Math.max(observedMax, inFlight);
        await sleep(5);
        inFlight -= 1;
        return { ok: true };
      },
    });
    const summary = await pool.drain();
    expect(summary.processed).toBe(12);
    expect(observedMax).toBeLessThanOrEqual(3);
    expect(observedMax).toBe(3);
    expect(pool.maxObservedConcurrency).toBeLessThanOrEqual(3);
  });

  it('streams progress from the handler into the job record', async () => {
    const queue = queueWithRetry();
    await enqueueRenderJobs(queue, 1);
    const seen: number[] = [];
    const unsubscribe = queue.onEvent((event) => {
      if (event.type === 'progress') seen.push(event.progress);
    });
    const pool = new WorkerPool({
      queue,
      size: 1,
      handler: createSimulatedRenderHandler({ chunkMs: 1, sleep }),
    });
    await pool.drain();
    unsubscribe();
    expect(seen).toEqual([33.33, 66.67, 100]);
    const [job] = await queue.list('completed');
    expect(job.progress).toBe(100);
  });

  it('retries a retryable failure and completes on a later attempt', async () => {
    const queue = queueWithRetry();
    const [job] = await enqueueRenderJobs(queue, 1);
    const pool = new WorkerPool({
      queue,
      size: 1,
      handler: createSimulatedRenderHandler({
        chunkMs: 1,
        sleep,
        failOn: (_job, attempt) => (attempt < 2 ? 'transient encoder error' : null),
      }),
    });
    const summary = await pool.drain();
    expect(summary.failed).toBe(1);
    expect(summary.succeeded).toBe(1);
    const stored = await queue.require(job.id);
    expect(stored.state).toBe('completed');
    expect(stored.attempts).toBe(2);
  });

  it('isolates a job that fails every attempt in the DLQ', async () => {
    const queue = queueWithRetry();
    const [job] = await enqueueRenderJobs(queue, 1);
    const pool = new WorkerPool({
      queue,
      size: 1,
      handler: createSimulatedRenderHandler({ chunkMs: 1, sleep, failOn: () => 'corrupt source' }),
    });
    const summary = await pool.drain();
    expect(summary.failed).toBe(3);
    expect((await queue.require(job.id)).state).toBe('dlq');
  });

  it('treats a non-retryable ShortformError as terminal on the first attempt', async () => {
    const queue = queueWithRetry();
    const [job] = await enqueueRenderJobs(queue, 1);
    const pool = new WorkerPool({
      queue,
      size: 1,
      handler: async () => {
        throw new ShortformError('unsupported codec', { code: 'MEDIA' });
      },
    });
    const summary = await pool.drain();
    const stored = await queue.require(job.id);
    expect(summary.failed).toBe(1);
    expect(stored.state).toBe('failed');
    expect(stored.attempts).toBe(1);
  });

  it('reports per-worker load with utilisation above zero', async () => {
    const queue = queueWithRetry();
    await enqueueRenderJobs(queue, 4);
    const pool = new WorkerPool({
      queue,
      size: 2,
      handler: async () => {
        await sleep(2);
        return { ok: true };
      },
    });
    await pool.drain();
    const loads = pool.loads;
    expect(loads).toHaveLength(2);
    expect(loads.every((load) => load.jobsProcessed >= 1)).toBe(true);
    expect(loads.some((load) => load.utilization > 0)).toBe(true);
  });

  it('calls onJobSettled for successes and failures', async () => {
    const queue = queueWithRetry();
    await enqueueRenderJobs(queue, 2);
    const settled: boolean[] = [];
    const pool = new WorkerPool({
      queue,
      size: 1,
      handler: async ({ job }) => {
        if (job.name === 'render-1') throw new Error('boom');
        return { ok: true };
      },
      onJobSettled: (info) => settled.push(info.ok),
    });
    await pool.drain();
    expect(settled.filter(Boolean)).toHaveLength(1);
    expect(settled.filter((ok) => !ok).length).toBeGreaterThanOrEqual(1);
  });

  it('honours maxJobs when draining a slice of the backlog', async () => {
    const queue = queueWithRetry();
    await enqueueRenderJobs(queue, 8);
    const pool = new WorkerPool({
      queue,
      size: 2,
      handler: createSimulatedRenderHandler({ chunkMs: 1, sleep }),
    });
    const summary = await pool.drain({ maxJobs: 3, waitForDelayed: false });
    expect(summary.processed).toBe(3);
    expect((await queue.counts()).waiting).toBe(5);
  });

  it('leaves delayed work in place when asked not to wait', async () => {
    const queue = queueWithRetry();
    await queue.enqueue({ tenantId: 't1', name: 'later', delayMs: 60_000 });
    const pool = new WorkerPool({ queue, size: 1, handler: async () => ({ ok: true }) });
    const summary = await pool.drain({ waitForDelayed: false });
    expect(summary.processed).toBe(0);
    expect((await queue.counts()).delayed).toBe(1);
  });

  it('returns immediately on an empty queue', async () => {
    const queue = queueWithRetry();
    const pool = new WorkerPool({ queue, size: 2, handler: async () => ({ ok: true }) });
    const summary = await pool.drain();
    expect(summary).toMatchObject({ processed: 0, succeeded: 0, failed: 0 });
  });

  it('serves continuously via start/stop until told to stop', async () => {
    const queue = queueWithRetry();
    const pool = new WorkerPool({
      queue,
      size: 2,
      idlePollMs: 2,
      handler: async () => {
        await sleep(1);
        return { ok: true };
      },
    });
    pool.start();
    await enqueueRenderJobs(queue, 5);
    for (let attempt = 0; attempt < 100 && (await queue.counts()).completed < 5; attempt += 1) {
      await sleep(5);
    }
    await pool.stop({ drain: true, timeoutMs: 2_000 });
    expect((await queue.counts()).completed).toBe(5);
  });

  it('refuses to drain while already serving', async () => {
    const queue = queueWithRetry();
    const pool = new WorkerPool({ queue, size: 1, idlePollMs: 5, handler: async () => ({ ok: true }) });
    pool.start();
    await expect(pool.drain()).rejects.toThrow(/already serving/);
    await pool.stop({ drain: false, timeoutMs: 1_000 });
  });
});

describe('render handlers', () => {
  it('bridges the queue to the real project renderer', async () => {
    const queue = queueWithRetry();
    const calls: Array<{ projectId: string; execute: boolean }> = [];
    const [job] = await enqueueRenderJobs(queue, 1);
    const pool = new WorkerPool({
      queue,
      size: 1,
      handler: createProjectRenderHandler({
        render: async (projectDir, config) => {
          calls.push({ projectId: projectDir, execute: config.execute });
          return { status: 'rendered', output: { path: `.work/${projectDir}/render.mp4` }, warnings: [] };
        },
      }),
    });
    await pool.drain();
    expect(calls).toEqual([{ projectId: 'proj-0', execute: true }]);
    const stored = await queue.require(job.id);
    expect(stored.state).toBe('completed');
    expect((stored.result as RenderJobResult).outputPath).toBe('.work/proj-0/render.mp4');
    expect((stored.result as RenderJobResult).simulated).toBe(false);
  });

  it('can plan a project through the queue without ffmpeg', async () => {
    const queue = queueWithRetry();
    const calls: boolean[] = [];
    await enqueueRenderJobs(queue, 1);
    const pool = new WorkerPool({
      queue,
      size: 1,
      handler: createProjectRenderHandler({
        execute: false,
        render: async (_projectDir, config) => {
          calls.push(config.execute);
          return { status: 'planned', output: { path: '.work/proj-0/render.mp4' }, warnings: [] };
        },
      }),
    });
    await pool.drain();
    expect(calls).toEqual([false]);
    expect((await queue.counts()).completed).toBe(1);
  });

  it('turns a failed render into a retryable job error', async () => {
    const queue = queueWithRetry();
    const [job] = await enqueueRenderJobs(queue, 1);
    const pool = new WorkerPool({
      queue,
      size: 1,
      handler: createProjectRenderHandler({
        render: async () => ({ status: 'failed', warnings: ['ffmpeg exited 1'] }),
      }),
    });
    await pool.drain();
    const stored = await queue.require(job.id);
    expect(stored.state).toBe('dlq');
    expect(stored.lastError).toContain('ffmpeg exited 1');
  });

  it('rejects a render payload that is not a valid job', async () => {
    const queue = queueWithRetry();
    const job = await queue.enqueue({ tenantId: 't1', name: 'bad', payload: { platform: 'reels' } });
    const pool = new WorkerPool({
      queue,
      size: 1,
      handler: createSimulatedRenderHandler({ chunkMs: 1, sleep }),
    });
    await pool.drain();
    expect((await queue.require(job.id)).state).toBe('failed');
  });

  it('splits the same timeline the compositor would encode', () => {
    const chunks = planRenderChunks(33.13, 3);
    expect(chunks.map((chunk) => chunk.endSec).at(-1)).toBe(33.13);
    expect(chunks.reduce((sum, chunk) => sum + chunk.frames, 0)).toBe(Math.round(33.13 * 30));
  });
});
