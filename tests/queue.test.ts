import { beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeRetryDelay, maxRetryBudgetMs } from '../src/lib/queue/backoff';
import { JobQueue } from '../src/lib/queue/jobQueue';
import { FileQueueStore } from '../src/lib/queue/fileStore';
import { WorkerPool } from '../src/lib/queue/workerPool';
import { createSimulatedRenderHandler, planRenderChunks, totalChunkWeight } from '../src/lib/queue/renderJob';
import { ShortformError } from '../src/lib/errors';
import type { JobEvent } from '../src/types/queue';

const START = Date.parse('2026-11-11T00:00:00.000Z');
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function harness(options: { leaseTimeoutMs?: number } = {}) {
  let clock = START;
  let sequence = 0;
  const events: JobEvent[] = [];
  const queue = new JobQueue({
    now: () => clock,
    random: () => 0,
    retry: { baseDelayMs: 1_000, maxDelayMs: 60_000, jitterRatio: 0, maxAttempts: 3 },
    leaseTimeoutMs: options.leaseTimeoutMs ?? 30_000,
    idFactory: () => `job_${++sequence}`,
    onEvent: (event) => events.push(event),
  });
  return {
    queue,
    events,
    advance: (ms: number) => {
      clock += ms;
    },
    now: () => clock,
  };
}

function renderPayload(durationSec = 45, chunkCount = 4) {
  return { projectId: 'proj-1', platform: 'instagram-reels' as const, durationSec, chunkCount };
}

describe('job queue lifecycle', () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => {
    h = harness();
  });

  it('enqueues a job as waiting with a transition and an event', async () => {
    const job = await h.queue.enqueue({ tenantId: 't1', name: 'render ep-1', payload: renderPayload() });
    expect(job.state).toBe('waiting');
    expect(job.attempts).toBe(0);
    expect(job.progress).toBe(0);
    expect(job.transitions).toEqual([{ from: null, to: 'waiting', at: new Date(START).toISOString() }]);
    expect(h.events.map((event) => event.type)).toEqual(['enqueued']);
  });

  it('runs higher priority first and keeps FIFO within a priority', async () => {
    const low = await h.queue.enqueue({ tenantId: 't1', name: 'low', priority: 1 });
    const high1 = await h.queue.enqueue({ tenantId: 't1', name: 'high-1', priority: 9 });
    const high2 = await h.queue.enqueue({ tenantId: 't1', name: 'high-2', priority: 9 });
    const mid = await h.queue.enqueue({ tenantId: 't1', name: 'mid', priority: 5 });

    const order: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      const job = await h.queue.reserve('worker-1');
      expect(job).not.toBeNull();
      order.push(job!.id);
      await h.queue.complete(job!.id);
    }
    expect(order).toEqual([high1.id, high2.id, mid.id, low.id]);
  });

  it('increments attempts and stamps the worker on reserve', async () => {
    const job = await h.queue.enqueue({ tenantId: 't1', name: 'render', payload: renderPayload() });
    const reserved = await h.queue.reserve('worker-7');
    expect(reserved?.id).toBe(job.id);
    expect(reserved?.state).toBe('active');
    expect(reserved?.attempts).toBe(1);
    expect(reserved?.workerId).toBe('worker-7');
    expect(reserved?.startedAt).toBe(new Date(START).toISOString());
    expect(h.events.map((event) => event.type)).toEqual(['enqueued', 'started']);
  });

  it('does not hand the same job to two workers', async () => {
    await h.queue.enqueue({ tenantId: 't1', name: 'only-one' });
    const first = await h.queue.reserve('worker-1');
    const second = await h.queue.reserve('worker-2');
    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });

  it('completes a job with result, progress 100 and finish time', async () => {
    const job = await h.queue.enqueue({ tenantId: 't1', name: 'render' });
    await h.queue.reserve('worker-1');
    h.advance(4_000);
    await h.queue.progress(job.id, 62.5);
    const done = await h.queue.complete(job.id, { outputPath: 'render.mp4' });
    expect(done.state).toBe('completed');
    expect(done.progress).toBe(100);
    expect(done.result).toEqual({ outputPath: 'render.mp4' });
    expect(done.finishedAt).toBe(new Date(START + 4_000).toISOString());
    expect(done.leaseExpiresAt).toBeNull();
  });

  it('keeps progress monotonic and emits one event per visible step', async () => {
    const job = await h.queue.enqueue({ tenantId: 't1', name: 'render' });
    await h.queue.reserve('worker-1');
    await h.queue.progress(job.id, 40);
    const afterRewind = await h.queue.progress(job.id, 10);
    expect(afterRewind.progress).toBe(40);
    expect(h.events.filter((event) => event.type === 'progress')).toHaveLength(1);
  });

  it('clamps progress into 0..100', async () => {
    const job = await h.queue.enqueue({ tenantId: 't1', name: 'render' });
    await h.queue.reserve('worker-1');
    expect((await h.queue.progress(job.id, 400)).progress).toBe(100);
    const fresh = await h.queue.enqueue({ tenantId: 't1', name: 'render-2' });
    await h.queue.reserve('worker-1');
    expect((await h.queue.progress(fresh.id, -5)).progress).toBe(0);
  });

  it('records a full transition chain waiting → active → completed', async () => {
    const job = await h.queue.enqueue({ tenantId: 't1', name: 'render' });
    await h.queue.reserve('worker-1');
    await h.queue.complete(job.id);
    const stored = await h.queue.require(job.id);
    expect(stored.transitions.map((entry) => entry.to)).toEqual(['waiting', 'active', 'completed']);
  });
});

describe('job queue scheduling and delays', () => {
  it('holds a delayed job until its window opens', async () => {
    const h = harness();
    const job = await h.queue.enqueue({ tenantId: 't1', name: 'scheduled', delayMs: 5_000 });
    expect(job.state).toBe('delayed');
    expect(await h.queue.reserve('worker-1')).toBeNull();

    h.advance(4_999);
    expect(await h.queue.reserve('worker-1')).toBeNull();

    h.advance(1);
    const reserved = await h.queue.reserve('worker-1');
    expect(reserved?.id).toBe(job.id);
    expect(reserved?.state).toBe('active');
  });

  it('reports the next due time so a pool can sleep instead of poll', async () => {
    const h = harness();
    await h.queue.enqueue({ tenantId: 't1', name: 'later', delayMs: 3_000 });
    expect(await h.queue.nextDueAt()).toBe(START + 3_000);
    const empty = harness();
    expect(await empty.queue.nextDueAt()).toBeNull();
  });

  it('promotes several due jobs in one pass', async () => {
    const h = harness();
    await h.queue.enqueue({ tenantId: 't1', name: 'a', delayMs: 1_000 });
    await h.queue.enqueue({ tenantId: 't1', name: 'b', delayMs: 2_000 });
    h.advance(2_000);
    expect(await h.queue.promoteDelayed()).toBe(2);
    expect((await h.queue.counts()).waiting).toBe(2);
  });

  it('does not let a high-priority job scheduled for later hide a due low-priority retry', async () => {
    const h = harness();
    const overnight = await h.queue.enqueue({
      tenantId: 't1',
      name: 'premium-slot',
      priority: 9,
      delayMs: 8 * 60 * 60 * 1_000,
    });
    const retry = await h.queue.enqueue({ tenantId: 't1', name: 'retry', priority: 1, delayMs: 1_000 });
    expect(overnight.state).toBe('delayed');

    h.advance(1_000);
    const reserved = await h.queue.reserve('worker-1');
    expect(reserved?.id).toBe(retry.id);
    expect(await h.queue.nextDueAt()).toBe(START + 8 * 60 * 60 * 1_000);
  });
});

describe('retry policy and dead letter queue', () => {
  it('backs off 1s, 2s, 4s before isolating the job', async () => {
    const h = harness();
    const job = await h.queue.enqueue({ tenantId: 't1', name: 'flaky', payload: renderPayload() });

    await h.queue.reserve('worker-1');
    const first = await h.queue.fail(job.id, new Error('encoder crashed'));
    expect(first.willRetry).toBe(true);
    expect(first.job.state).toBe('delayed');
    expect(Date.parse(first.job.availableAt) - h.now()).toBe(1_000);

    h.advance(1_000);
    await h.queue.reserve('worker-1');
    const second = await h.queue.fail(job.id, new Error('encoder crashed again'));
    expect(Date.parse(second.job.availableAt) - h.now()).toBe(2_000);

    h.advance(2_000);
    await h.queue.reserve('worker-1');
    const third = await h.queue.fail(job.id, new Error('still failing'));
    expect(third.willRetry).toBe(false);
    expect(third.job.state).toBe('dlq');
    expect(third.job.attempts).toBe(3);
    expect(third.job.lastError).toBe('still failing');
    expect(h.events.filter((event) => event.type === 'dlq')).toHaveLength(1);
  });

  it('sends a non-retryable error straight to failed, not to the DLQ', async () => {
    const h = harness();
    const job = await h.queue.enqueue({ tenantId: 't1', name: 'bad-media' });
    await h.queue.reserve('worker-1');
    const result = await h.queue.fail(job.id, new ShortformError('unsupported codec', { code: 'MEDIA' }), {
      retryable: false,
    });
    expect(result.willRetry).toBe(false);
    expect(result.job.state).toBe('failed');
    expect(result.job.attempts).toBe(1);
  });

  it('respects a per-job attempt ceiling lower than the queue default', async () => {
    const h = harness();
    const job = await h.queue.enqueue({ tenantId: 't1', name: 'one-shot', maxAttempts: 1 });
    await h.queue.reserve('worker-1');
    const result = await h.queue.fail(job.id, new Error('nope'));
    expect(result.job.state).toBe('dlq');
  });

  it('replays a DLQ job with a clean slate and it can then succeed', async () => {
    const h = harness();
    const job = await h.queue.enqueue({ tenantId: 't1', name: 'flaky', payload: renderPayload() });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await h.queue.reserve('worker-1');
      await h.queue.fail(job.id, new Error(`fail ${attempt}`));
      h.advance(10_000);
    }
    expect((await h.queue.require(job.id)).state).toBe('dlq');

    const replayed = await h.queue.replay(job.id);
    expect(replayed.state).toBe('waiting');
    expect(replayed.attempts).toBe(0);
    expect(replayed.progress).toBe(0);
    expect(replayed.lastError).toBeNull();

    await h.queue.reserve('worker-1');
    const done = await h.queue.complete(job.id, { ok: true });
    expect(done.state).toBe('completed');
  });

  it('refuses to replay a job that is still live', async () => {
    const h = harness();
    const job = await h.queue.enqueue({ tenantId: 't1', name: 'live' });
    await expect(h.queue.replay(job.id)).rejects.toThrow(/only dlq\/failed/);
  });

  it('recovers a stalled job after its lease expires', async () => {
    const h = harness({ leaseTimeoutMs: 1_000 });
    await h.queue.enqueue({ tenantId: 't1', name: 'stalled' });
    await h.queue.reserve('worker-1');
    h.advance(1_500);
    const recovered = await h.queue.recoverStalled();
    expect(recovered).toHaveLength(1);
    expect(recovered[0].state).toBe('delayed');
    expect(h.events.some((event) => event.type === 'stalled')).toBe(true);
  });

  it('extends the lease on heartbeat and rejects a foreign worker', async () => {
    const h = harness({ leaseTimeoutMs: 1_000 });
    const job = await h.queue.enqueue({ tenantId: 't1', name: 'slow' });
    await h.queue.reserve('worker-1');
    h.advance(800);
    const beat = await h.queue.heartbeat(job.id, 'worker-1');
    expect(Date.parse(beat.leaseExpiresAt ?? '')).toBe(h.now() + 1_000);
    await expect(h.queue.heartbeat(job.id, 'worker-2')).rejects.toThrow(/leased by worker-1/);
  });
});

describe('idempotency, retention and statistics', () => {
  it('deduplicates an enqueue while the first job is live', async () => {
    const h = harness();
    const first = await h.queue.enqueue({ tenantId: 't1', name: 'render', dedupeKey: 'ep-1:reels' });
    const second = await h.queue.enqueue({ tenantId: 't1', name: 'render', dedupeKey: 'ep-1:reels' });
    expect(second.id).toBe(first.id);
    expect(await h.queue.list()).toHaveLength(1);
    expect(h.events.some((event) => event.type === 'deduped')).toBe(true);
  });

  it('allows a new job with the same key after the first one completed', async () => {
    const h = harness();
    const first = await h.queue.enqueue({ tenantId: 't1', name: 'render', dedupeKey: 'ep-1:reels' });
    await h.queue.reserve('worker-1');
    await h.queue.complete(first.id);
    const second = await h.queue.enqueue({ tenantId: 't1', name: 'render', dedupeKey: 'ep-1:reels' });
    expect(second.id).not.toBe(first.id);
  });

  it('computes counts, success rate, latency percentiles and retries', async () => {
    const h = harness();
    for (let index = 0; index < 3; index += 1) {
      const job = await h.queue.enqueue({ tenantId: 't1', name: `job-${index}` });
      await h.queue.reserve('worker-1');
      h.advance(1_000 * (index + 1));
      await h.queue.complete(job.id);
    }
    const failing = await h.queue.enqueue({ tenantId: 't1', name: 'failing', maxAttempts: 1 });
    await h.queue.reserve('worker-1');
    await h.queue.fail(failing.id, new Error('boom'));

    const stats = await h.queue.stats();
    expect(stats.counts.completed).toBe(3);
    expect(stats.counts.dlq).toBe(1);
    expect(stats.total).toBe(4);
    expect(stats.successRate).toBe(0.75);
    expect(stats.meanLatencyMs).toBe(2_000);
    expect(stats.p95LatencyMs).toBe(3_000);
    expect(stats.retries).toBe(0);
  });

  it('reports a zero success rate before anything reaches a terminal state', async () => {
    const h = harness();
    await h.queue.enqueue({ tenantId: 't1', name: 'pending' });
    expect((await h.queue.stats()).successRate).toBe(0);
  });

  it('purges old terminal jobs only', async () => {
    const h = harness();
    const done = await h.queue.enqueue({ tenantId: 't1', name: 'old' });
    await h.queue.reserve('worker-1');
    await h.queue.complete(done.id);
    await h.queue.enqueue({ tenantId: 't1', name: 'still-waiting' });
    h.advance(8 * 24 * 60 * 60 * 1_000);
    expect(await h.queue.purgeTerminal(7 * 24 * 60 * 60 * 1_000)).toBe(1);
    expect((await h.queue.list()).map((job) => job.name)).toEqual(['still-waiting']);
  });

  it('rejects unknown jobs and invalid enqueue input', async () => {
    const h = harness();
    await expect(h.queue.require('job_nope')).rejects.toThrow(/not found/);
    await expect(h.queue.enqueue({ tenantId: '', name: 'x' })).rejects.toThrow();
  });

  it('lists jobs by state', async () => {
    const h = harness();
    await h.queue.enqueue({ tenantId: 't1', name: 'a' });
    await h.queue.enqueue({ tenantId: 't1', name: 'b', delayMs: 5_000 });
    expect((await h.queue.list('waiting')).map((job) => job.name)).toEqual(['a']);
    expect((await h.queue.list('delayed')).map((job) => job.name)).toEqual(['b']);
  });

  it('keeps two tenants in one queue without mixing their jobs', async () => {
    const h = harness();
    await h.queue.enqueue({ tenantId: 't1', name: 'a' });
    await h.queue.enqueue({ tenantId: 't2', name: 'b' });
    const jobs = await h.queue.list();
    expect(jobs.map((job) => job.tenantId).sort()).toEqual(['t1', 't2']);
  });
});

describe('backoff math', () => {
  it('doubles from the base delay and respects the ceiling', () => {
    const policy = { baseDelayMs: 1_000, maxDelayMs: 8_000, jitterRatio: 0 };
    expect(computeRetryDelay(1, policy)).toBe(1_000);
    expect(computeRetryDelay(2, policy)).toBe(2_000);
    expect(computeRetryDelay(3, policy)).toBe(4_000);
    expect(computeRetryDelay(4, policy)).toBe(8_000);
    expect(computeRetryDelay(9, policy)).toBe(8_000);
  });

  it('keeps jittered delays inside the upper part of the window', () => {
    const policy = { baseDelayMs: 1_000, maxDelayMs: 30_000, jitterRatio: 0.5 };
    expect(computeRetryDelay(1, policy, () => 0)).toBe(500);
    expect(computeRetryDelay(1, policy, () => 1)).toBe(1_000);
    expect(computeRetryDelay(2, policy, () => 0.5)).toBe(1_500);
  });

  it('sums the retry budget of a policy', () => {
    expect(maxRetryBudgetMs({ baseDelayMs: 1_000, maxDelayMs: 60_000, jitterRatio: 0, maxAttempts: 4 })).toBe(7_000);
  });
});

describe('render chunk planning', () => {
  it('covers the timeline exactly and weights the flush chunk heavier', () => {
    const chunks = planRenderChunks(60, 4);
    expect(chunks).toHaveLength(4);
    expect(chunks[0].startSec).toBe(0);
    expect(chunks[3].endSec).toBe(60);
    for (let index = 1; index < chunks.length; index += 1) {
      expect(chunks[index].startSec).toBe(chunks[index - 1].endSec);
    }
    expect(chunks[3].weight).toBeGreaterThan(chunks[0].weight);
    expect(totalChunkWeight(chunks)).toBeCloseTo(4.35, 5);
  });

  it('produces at least one frame per chunk', () => {
    for (const chunk of planRenderChunks(1, 8)) {
      expect(chunk.frames).toBeGreaterThanOrEqual(1);
    }
  });

  it('clamps the chunk count and rejects a non-positive duration', () => {
    expect(planRenderChunks(10, 0)).toHaveLength(1);
    expect(planRenderChunks(10, 999)).toHaveLength(64);
    expect(() => planRenderChunks(0, 4)).toThrow(/positive/);
  });
});

describe('file-backed queue store', () => {
  it('starts empty when the state file does not exist', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'shortform-queue-'));
    try {
      const queue = new JobQueue({ store: new FileQueueStore(join(dir, 'nested', 'state.json')) });
      expect(await queue.list()).toHaveLength(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('persists jobs across separate queue instances', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'shortform-queue-'));
    const path = join(dir, 'state.json');
    try {
      const first = new JobQueue({ store: new FileQueueStore(path), idFactory: () => 'job_fixed' });
      await first.enqueue({ tenantId: 't1', name: 'persisted render', payload: renderPayload() });
      const second = new JobQueue({ store: new FileQueueStore(path) });
      const jobs = await second.list();
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({ id: 'job_fixed', tenantId: 't1', name: 'persisted render' });
      const reserved = await second.reserve('worker-1');
      expect(reserved?.name).toBe('persisted render');
      const third = new JobQueue({ store: new FileQueueStore(path) });
      expect((await third.require('job_fixed')).state).toBe('active');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('survives concurrent worker writes without losing jobs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'shortform-queue-'));
    const path = join(dir, 'state.json');
    try {
      const queue = new JobQueue({
        store: new FileQueueStore(path),
        retry: { baseDelayMs: 5, maxDelayMs: 20, jitterRatio: 0, maxAttempts: 2 },
      });
      for (let index = 0; index < 6; index += 1) {
        await queue.enqueue({
          tenantId: 't1',
          name: `job-${index}`,
          payload: { projectId: `p-${index}`, platform: 'instagram-reels', durationSec: 20, chunkCount: 2 },
        });
      }
      const pool = new WorkerPool({
        queue,
        size: 3,
        handler: createSimulatedRenderHandler({ chunkMs: 1, sleep }),
      });
      await pool.drain();
      const reloaded = new JobQueue({ store: new FileQueueStore(path) });
      const counts = await reloaded.counts();
      expect(counts.completed).toBe(6);
      expect(counts.active).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
