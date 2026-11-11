import type { JobEvent, QueueJob } from '../../types/queue';
import { ShortformError } from '../errors';
import type { JobQueue } from './jobQueue';

export interface WorkerContext {
  job: QueueJob;
  /** 1-based attempt number, already counted by the queue. */
  attempt: number;
  workerId: string;
  signal: AbortSignal;
  reportProgress: (percent: number) => Promise<void>;
}

export type JobHandler<T = unknown> = (context: WorkerContext) => Promise<T>;

export interface WorkerLoad {
  workerId: string;
  state: 'idle' | 'busy' | 'stopped';
  jobsProcessed: number;
  jobsFailed: number;
  busyMs: number;
  /** Share of wall-clock the worker spent inside a handler, 0–1. */
  utilization: number;
}

export interface WorkerPoolOptions {
  queue: JobQueue;
  handler: JobHandler;
  /** Number of concurrent lanes. This is the CPU bound: encoding is the cost. */
  size?: number;
  idlePollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  onEvent?: (event: JobEvent) => void;
  onJobSettled?: (info: { job: QueueJob; ok: boolean; error?: string }) => void;
}

export interface PoolSummary {
  processed: number;
  succeeded: number;
  failed: number;
  maxConcurrency: number;
  durationMs: number;
}

interface Lane {
  id: string;
  state: 'idle' | 'busy' | 'stopped';
  jobsProcessed: number;
  jobsFailed: number;
  busyMs: number;
  idleMs: number;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A fixed-size worker pool over `JobQueue`. It holds no job state of its own:
 * the queue is the source of truth, so a pool can be restarted, scaled down or
 * killed and the backlog resumes where it was.
 */
export class WorkerPool {
  private readonly queue: JobQueue;
  private readonly handler: JobHandler;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly idlePollMs: number;
  private readonly onJobSettled?: WorkerPoolOptions['onJobSettled'];
  private readonly lanes: Lane[];
  private readonly abortController = new AbortController();
  private running = false;
  private stopRequested = false;
  private startedAtMs = 0;
  private maxConcurrency = 0;
  private active = 0;
  private readonly loopPromises: Promise<void>[] = [];
  private readonly unsubscribe: (() => void) | null;

  constructor(options: WorkerPoolOptions) {
    this.queue = options.queue;
    this.handler = options.handler;
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? (() => Date.now());
    this.idlePollMs = options.idlePollMs ?? 50;
    this.onJobSettled = options.onJobSettled;
    const size = Math.max(1, Math.floor(options.size ?? 4));
    this.lanes = Array.from({ length: size }, (_, index) => ({
      id: `worker-${index + 1}`,
      state: 'idle',
      jobsProcessed: 0,
      jobsFailed: 0,
      busyMs: 0,
      idleMs: 0,
    }));
    this.unsubscribe = options.onEvent ? this.queue.onEvent(options.onEvent) : null;
  }

  get size(): number {
    return this.lanes.length;
  }

  get maxObservedConcurrency(): number {
    return this.maxConcurrency;
  }

  get loads(): WorkerLoad[] {
    const elapsed = this.startedAtMs === 0 ? 0 : Math.max(1, this.now() - this.startedAtMs);
    return this.lanes.map((lane) => ({
      workerId: lane.id,
      state: this.stopRequested && lane.state === 'idle' ? 'stopped' : lane.state,
      jobsProcessed: lane.jobsProcessed,
      jobsFailed: lane.jobsFailed,
      busyMs: Math.round(lane.busyMs),
      // Share of the pool's wall-clock lifetime spent inside a handler. Idle
      // polling and backoff waits count against it, which is the number an
      // operator wants when deciding whether to add a node.
      utilization: elapsed === 0 ? 0 : Math.min(1, Math.round((lane.busyMs / elapsed) * 1_000) / 1_000),
    }));
  }

  summary(): PoolSummary {
    const succeeded = this.lanes.reduce((sum, lane) => sum + lane.jobsProcessed, 0);
    const failed = this.lanes.reduce((sum, lane) => sum + lane.jobsFailed, 0);
    return {
      processed: succeeded + failed,
      succeeded,
      failed,
      maxConcurrency: this.maxConcurrency,
      durationMs: this.startedAtMs === 0 ? 0 : Math.max(0, this.now() - this.startedAtMs),
    };
  }

  /**
   * Start serving until `stop()`. Resolves when every lane has finished,
   * so `await pool.start()` is not how you wait — `stop({ drain: true })` is.
   */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.stopRequested = false;
    this.startedAtMs = this.now();
    for (const lane of this.lanes) {
      this.loopPromises.push(this.serve(lane));
    }
  }

  async stop(options: { drain?: boolean; timeoutMs?: number } = {}): Promise<void> {
    if (options.drain === false) this.abortController.abort();
    this.stopRequested = true;
    const timeout = options.timeoutMs ?? 60_000;
    const deadline = this.now() + timeout;
    while (this.active > 0 && this.now() < deadline) {
      await this.sleep(Math.min(this.idlePollMs, 25));
    }
    await Promise.allSettled(this.loopPromises);
    this.running = false;
    if (this.unsubscribe) this.unsubscribe();
  }

  /**
   * Process the current backlog with `size` lanes and return. This is what a
   * batch job (nightly 30-episode render) uses; `start()` is for a daemon.
   */
  async drain(
    options: { waitForDelayed?: boolean; maxDrainMs?: number; maxJobs?: number } = {},
  ): Promise<PoolSummary> {
    if (this.running) {
      throw new ShortformError('pool is already serving; stop it before drain', { code: 'VALIDATION' });
    }
    this.running = true;
    this.startedAtMs = this.now();
    const deadline = this.now() + (options.maxDrainMs ?? 120_000);
    const waitForDelayed = options.waitForDelayed ?? true;
    const budget = options.maxJobs ?? Number.POSITIVE_INFINITY;
    let taken = 0;

    const lane = async (worker: Lane): Promise<void> => {
      while (taken < budget) {
        if (this.now() > deadline) return;
        // Claim the slot before awaiting: concurrent lanes must not all pass
        // the check and overshoot `maxJobs` by `size - 1`.
        taken += 1;
        const processed = await this.processNext(worker);
        if (processed) continue;
        taken -= 1;
        if (!waitForDelayed) return;
        const due = await this.queue.nextDueAt();
        if (due === null) return;
        const delay = Math.max(0, Math.min(due - this.now(), deadline - this.now(), 1_000));
        await this.sleep(delay);
        worker.idleMs += delay;
      }
    };

    await Promise.all(this.lanes.map((worker) => lane(worker)));
    this.running = false;
    if (this.unsubscribe) this.unsubscribe();
    return this.summary();
  }

  /** One unit of work. Returns false when there is nothing to claim. */
  async processNext(worker: Lane = this.lanes[0]): Promise<boolean> {
    const job = await this.queue.reserve(worker.id);
    if (!job) {
      worker.state = 'idle';
      return false;
    }
    worker.state = 'busy';
    this.active += 1;
    this.maxConcurrency = Math.max(this.maxConcurrency, this.active);
    const startedAt = this.now();
    try {
      const result = await this.handler({
        job,
        attempt: job.attempts,
        workerId: worker.id,
        signal: this.abortController.signal,
        reportProgress: (percent) => this.queue.progress(job.id, percent).then(() => undefined),
      });
      await this.queue.complete(job.id, result);
      worker.jobsProcessed += 1;
      this.onJobSettled?.({ job, ok: true });
    } catch (error) {
      const retryable = !(error instanceof ShortformError) || error.retryable;
      const message = error instanceof Error ? error.message : String(error);
      await this.queue.fail(job.id, error, { retryable }).catch(() => undefined);
      worker.jobsFailed += 1;
      this.onJobSettled?.({ job, ok: false, error: message });
    } finally {
      worker.busyMs += Math.max(0, this.now() - startedAt);
      worker.state = 'idle';
      this.active -= 1;
    }
    return true;
  }

  private async serve(worker: Lane): Promise<void> {
    while (!this.stopRequested) {
      const processed = await this.processNext(worker);
      if (!processed) {
        if (this.stopRequested) return;
        await this.sleep(this.idlePollMs);
        worker.idleMs += this.idlePollMs;
      }
    }
  }
}
