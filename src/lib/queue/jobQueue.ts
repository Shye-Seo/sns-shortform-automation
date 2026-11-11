import { randomUUID } from 'node:crypto';
import {
  EnqueueInputSchema,
  RetryPolicySchema,
  type EnqueueInput,
  type JobEvent,
  type JobState,
  type QueueCounts,
  type QueueJob,
  type QueueStats,
  type RetryPolicy,
} from '../../types/queue';
import { ShortformError } from '../errors';
import { computeRetryDelay } from './backoff';
import { BinaryHeap } from './priorityHeap';

/**
 * Persistence boundary. `InMemoryQueueStore` is enough for one process and for
 * tests; the same interface maps 1:1 onto Redis (`HSET job:{id}`, `ZADD ready`)
 * or Postgres (`SELECT … FOR UPDATE SKIP LOCKED`). Nothing above this line
 * knows which one it is talking to.
 */
export interface QueueStore {
  get(id: string): Promise<QueueJob | undefined>;
  put(job: QueueJob): Promise<void>;
  delete(id: string): Promise<void>;
  all(): Promise<QueueJob[]>;
}

export class InMemoryQueueStore implements QueueStore {
  private readonly jobs = new Map<string, QueueJob>();

  async get(id: string): Promise<QueueJob | undefined> {
    const job = this.jobs.get(id);
    return job ? structuredClone(job) : undefined;
  }

  async put(job: QueueJob): Promise<void> {
    this.jobs.set(job.id, structuredClone(job));
  }

  async delete(id: string): Promise<void> {
    this.jobs.delete(id);
  }

  async all(): Promise<QueueJob[]> {
    return [...this.jobs.values()].map((job) => structuredClone(job));
  }

  async clear(): Promise<void> {
    this.jobs.clear();
  }
}

export interface JobQueueOptions {
  store?: QueueStore;
  now?: () => number;
  random?: () => number;
  idFactory?: () => string;
  retry?: Partial<RetryPolicy>;
  /** How long a worker owns an `active` job before it is considered stalled. */
  leaseTimeoutMs?: number;
  onEvent?: (event: JobEvent) => void;
}

interface HeapEntry {
  id: string;
  priority: number;
  availableAtMs: number;
  createdAtMs: number;
}

/** Higher priority first, then earliest due, then FIFO. */
function compareEntries(a: HeapEntry, b: HeapEntry): number {
  if (a.priority !== b.priority) return b.priority - a.priority;
  if (a.availableAtMs !== b.availableAtMs) return a.availableAtMs - b.availableAtMs;
  if (a.createdAtMs !== b.createdAtMs) return a.createdAtMs - b.createdAtMs;
  return a.id.localeCompare(b.id);
}

/**
 * Delayed jobs are ordered by time only. Ordering them by priority would let a
 * high-priority job scheduled for tomorrow morning sit at the top of the heap
 * and hide a low-priority retry that is already due.
 */
function compareDue(a: HeapEntry, b: HeapEntry): number {
  if (a.availableAtMs !== b.availableAtMs) return a.availableAtMs - b.availableAtMs;
  if (a.createdAtMs !== b.createdAtMs) return a.createdAtMs - b.createdAtMs;
  return a.id.localeCompare(b.id);
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function msOf(value: string | null): number {
  return value ? Date.parse(value) : Number.POSITIVE_INFINITY;
}

export interface FailOptions {
  /** Defaults to the error's `retryable` flag, then true. */
  retryable?: boolean;
}

export class JobQueue {
  private readonly store: QueueStore;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly idFactory: () => string;
  private readonly retry: RetryPolicy;
  private readonly leaseTimeoutMs: number;
  private readonly ready = new BinaryHeap<HeapEntry>(compareEntries);
  private readonly delayed = new BinaryHeap<HeapEntry>(compareDue);
  private readonly listeners = new Set<(event: JobEvent) => void>();
  private readonly eventLog: JobEvent[] = [];
  /** Indexes are rebuilt once from the store, so a restarted worker resumes a persisted backlog. */
  private hydration: Promise<void> | null = null;

  constructor(options: JobQueueOptions = {}) {
    this.store = options.store ?? new InMemoryQueueStore();
    this.now = options.now ?? (() => Date.now());
    this.random = options.random ?? Math.random;
    this.idFactory = options.idFactory ?? (() => `job_${randomUUID()}`);
    this.retry = RetryPolicySchema.parse({
      baseDelayMs: 1_000,
      maxDelayMs: 30_000,
      jitterRatio: 0,
      maxAttempts: 3,
      ...options.retry,
    });
    this.leaseTimeoutMs = options.leaseTimeoutMs ?? 30_000;
    if (options.onEvent) this.listeners.add(options.onEvent);
  }

  onEvent(handler: (event: JobEvent) => void): () => void {
    this.listeners.add(handler);
    return () => this.listeners.delete(handler);
  }

  get events(): JobEvent[] {
    return [...this.eventLog];
  }

  private emit(event: JobEvent): void {
    this.eventLog.push(event);
    for (const listener of this.listeners) listener(event);
  }

  private async transition(
    job: QueueJob,
    to: JobState,
    reason?: string,
  ): Promise<QueueJob> {
    job.transitions.push({ from: job.state, to, at: iso(this.now()), reason });
    job.state = to;
    job.updatedAt = iso(this.now());
    await this.store.put(job);
    return job;
  }

  private hydrate(): Promise<void> {
    if (this.hydration) return this.hydration;
    this.hydration = (async () => {
      for (const job of await this.store.all()) {
        if (job.state === 'waiting') this.ready.push(this.entry(job));
        else if (job.state === 'delayed') this.delayed.push(this.entry(job));
      }
    })();
    return this.hydration;
  }

  private entry(job: QueueJob): HeapEntry {
    return {
      id: job.id,
      priority: job.priority,
      availableAtMs: msOf(job.availableAt),
      createdAtMs: msOf(job.createdAt),
    };
  }

  private schedule(job: QueueJob): void {
    if (job.state === 'waiting') this.ready.push(this.entry(job));
    if (job.state === 'delayed') this.delayed.push(this.entry(job));
  }

  /**
   * Idempotent enqueue. A second enqueue with the same `dedupeKey` while the
   * first is still live (waiting/delayed/active) returns the live job — a
   * webhook retry must not render the same episode twice.
   */
  async enqueue(input: EnqueueInput): Promise<QueueJob> {
    const parsed = EnqueueInputSchema.parse(input);
    await this.hydrate();
    const nowMs = this.now();

    if (parsed.dedupeKey) {
      const live = (await this.store.all()).find(
        (job) =>
          job.dedupeKey === parsed.dedupeKey &&
          (job.state === 'waiting' || job.state === 'delayed' || job.state === 'active'),
      );
      if (live) {
        this.emit({ type: 'deduped', at: iso(nowMs), job: live });
        return live;
      }
    }

    const availableAtMs = nowMs + (parsed.delayMs ?? 0);
    const job: QueueJob = {
      id: this.idFactory(),
      tenantId: parsed.tenantId,
      name: parsed.name,
      kind: parsed.kind,
      state: availableAtMs > nowMs ? 'delayed' : 'waiting',
      priority: parsed.priority,
      payload: parsed.payload,
      attempts: 0,
      maxAttempts: parsed.maxAttempts ?? this.retry.maxAttempts,
      progress: 0,
      createdAt: iso(nowMs),
      updatedAt: iso(nowMs),
      availableAt: iso(availableAtMs),
      startedAt: null,
      finishedAt: null,
      leaseExpiresAt: null,
      workerId: null,
      dedupeKey: parsed.dedupeKey ?? null,
      lastError: null,
      result: null,
      transitions: [{ from: null, to: availableAtMs > nowMs ? 'delayed' : 'waiting', at: iso(nowMs) }],
    };
    await this.store.put(job);
    this.schedule(job);
    this.emit({ type: 'enqueued', at: iso(nowMs), job });
    return job;
  }

  /** Move every `delayed` job whose window has opened back into `waiting`. */
  async promoteDelayed(): Promise<number> {
    await this.hydrate();
    const nowMs = this.now();
    let promoted = 0;
    for (;;) {
      const next = this.delayed.peek();
      if (!next) break;
      const job = await this.store.get(next.id);
      // A stale entry (job re-delayed to a new time) is dropped, not re-pushed:
      // the reschedule already pushed an entry with the current availableAt.
      if (!job || job.state !== 'delayed' || msOf(job.availableAt) !== next.availableAtMs) {
        this.delayed.pop();
        continue;
      }
      if (next.availableAtMs > nowMs) break;
      this.delayed.pop();
      await this.transition(job, 'waiting', 'delay elapsed');
      this.ready.push(this.entry(job));
      promoted += 1;
    }
    return promoted;
  }

  /**
   * Atomically claim the next runnable job for `workerId`. Returns null when
   * nothing is due — a worker that finds null polls, it does not spin a job.
   */
  async reserve(workerId: string): Promise<QueueJob | null> {
    if (!workerId) throw new ShortformError('workerId is required to reserve', { code: 'VALIDATION' });
    await this.hydrate();
    await this.promoteDelayed();

    for (;;) {
      const next = this.ready.peek();
      if (!next) return null;
      if (next.availableAtMs > this.now()) return null;
      this.ready.pop();

      const job = await this.store.get(next.id);
      if (!job || job.state !== 'waiting') continue;
      if (msOf(job.availableAt) > this.now()) {
        this.ready.push(this.entry(job));
        return null;
      }

      const nowMs = this.now();
      job.attempts += 1;
      job.workerId = workerId;
      job.startedAt = job.startedAt ?? iso(nowMs);
      job.leaseExpiresAt = iso(nowMs + this.leaseTimeoutMs);
      await this.transition(job, 'active', `reserved by ${workerId}`);
      this.emit({ type: 'started', at: iso(nowMs), job });
      return job;
    }
  }

  async heartbeat(jobId: string, workerId?: string): Promise<QueueJob> {
    const job = await this.require(jobId);
    if (job.state !== 'active') {
      throw new ShortformError(`job ${jobId} is ${job.state}, not active`, { code: 'VALIDATION' });
    }
    if (workerId && job.workerId !== workerId) {
      throw new ShortformError(`job ${jobId} is leased by ${job.workerId ?? 'nobody'}`, {
        code: 'VALIDATION',
      });
    }
    job.leaseExpiresAt = iso(this.now() + this.leaseTimeoutMs);
    job.updatedAt = iso(this.now());
    await this.store.put(job);
    return job;
  }

  /** Progress is monotonic: a late chunk event must not rewind the bar. */
  async progress(jobId: string, percent: number): Promise<QueueJob> {
    const job = await this.require(jobId);
    if (job.state !== 'active') {
      throw new ShortformError(`job ${jobId} is ${job.state}, not active`, { code: 'VALIDATION' });
    }
    const next = Math.min(100, Math.max(0, Number.isFinite(percent) ? percent : job.progress));
    const rounded = Math.round(next * 100) / 100;
    if (rounded <= job.progress) return job;
    job.progress = rounded;
    job.updatedAt = iso(this.now());
    job.leaseExpiresAt = iso(this.now() + this.leaseTimeoutMs);
    await this.store.put(job);
    this.emit({ type: 'progress', at: iso(this.now()), job, progress: rounded });
    return job;
  }

  async complete(jobId: string, result: unknown = null): Promise<QueueJob> {
    const job = await this.require(jobId);
    if (job.state === 'completed') return job;
    if (job.state !== 'active') {
      throw new ShortformError(`job ${jobId} is ${job.state}, not active`, { code: 'VALIDATION' });
    }
    job.result = result;
    job.progress = 100;
    job.finishedAt = iso(this.now());
    job.leaseExpiresAt = null;
    await this.transition(job, 'completed');
    this.emit({ type: 'completed', at: iso(this.now()), job });
    return job;
  }

  /**
   * Record a failure. Retryable failures with attempts left go back to
   * `delayed` with exponential backoff; exhausted retries are isolated in the
   * DLQ; non-retryable failures stop at `failed` because replaying them would
   * only fail again.
   */
  async fail(
    jobId: string,
    error: unknown,
    options: FailOptions = {},
  ): Promise<{ job: QueueJob; willRetry: boolean }> {
    const job = await this.require(jobId);
    if (job.state !== 'active') {
      throw new ShortformError(`job ${jobId} is ${job.state}, not active`, { code: 'VALIDATION' });
    }
    const message = error instanceof Error ? error.message : String(error);
    const retryable = options.retryable ?? true;
    const nowMs = this.now();
    job.lastError = message;
    job.workerId = null;
    job.leaseExpiresAt = null;

    if (retryable && job.attempts < job.maxAttempts) {
      const delayMs = computeRetryDelay(job.attempts, this.retry, this.random);
      job.availableAt = iso(nowMs + delayMs);
      await this.transition(job, 'delayed', `retry ${job.attempts + 1}/${job.maxAttempts} in ${delayMs}ms`);
      this.delayed.push(this.entry(job));
      this.emit({ type: 'failed', at: iso(nowMs), job, error: message, willRetry: true });
      this.emit({
        type: 'retried',
        at: iso(nowMs),
        job,
        delayMs,
        attempt: job.attempts + 1,
      });
      return { job, willRetry: true };
    }

    job.finishedAt = iso(nowMs);
    const exhausted = retryable;
    await this.transition(job, exhausted ? 'dlq' : 'failed', exhausted ? 'retries exhausted' : 'non-retryable');
    this.emit({ type: 'failed', at: iso(nowMs), job, error: message, willRetry: false });
    if (exhausted) this.emit({ type: 'dlq', at: iso(nowMs), job, reason: message });
    return { job, willRetry: false };
  }

  /**
   * Requeue jobs whose lease expired (worker OOM, node drained, clock skew).
   * Their attempt counter already includes the lost run, so a job that dies on
   * every attempt still lands in the DLQ instead of looping forever.
   */
  async recoverStalled(): Promise<QueueJob[]> {
    const nowMs = this.now();
    const stalled = (await this.store.all()).filter(
      (job) => job.state === 'active' && job.leaseExpiresAt !== null && msOf(job.leaseExpiresAt) < nowMs,
    );
    const recovered: QueueJob[] = [];
    for (const job of stalled) {
      this.emit({ type: 'stalled', at: iso(nowMs), job });
      const { job: next } = await this.fail(job.id, new Error('lease expired: worker stopped responding'));
      recovered.push(next);
    }
    return recovered;
  }

  /** Operator action: move a DLQ/failed job back to `waiting` with a clean slate. */
  async replay(jobId: string): Promise<QueueJob> {
    await this.hydrate();
    const job = await this.require(jobId);
    if (job.state !== 'dlq' && job.state !== 'failed') {
      throw new ShortformError(`job ${jobId} is ${job.state}; only dlq/failed jobs can be replayed`, {
        code: 'VALIDATION',
      });
    }
    job.attempts = 0;
    job.progress = 0;
    job.lastError = null;
    job.result = null;
    job.workerId = null;
    job.leaseExpiresAt = null;
    job.startedAt = null;
    job.finishedAt = null;
    job.availableAt = iso(this.now());
    await this.transition(job, 'waiting', 'replayed by operator');
    this.ready.push(this.entry(job));
    this.emit({ type: 'replayed', at: iso(this.now()), job });
    return job;
  }

  /**
   * Operator action: give up on a DLQ/failed job.
   *
   * The row is removed (the job will never run again), but not silently: a
   * `discarded` event with the reason stays in the queue event log, so the
   * decision is auditable even though the job is gone. Only DLQ/failed jobs can
   * be discarded — discarding a waiting or active job would erase work that is
   * still in flight.
   */
  async discard(jobId: string, reason = 'discarded by operator'): Promise<QueueJob> {
    await this.hydrate();
    const job = await this.require(jobId);
    if (job.state !== 'dlq' && job.state !== 'failed') {
      throw new ShortformError(`job ${jobId} is ${job.state}; only dlq/failed jobs can be discarded`, {
        code: 'VALIDATION',
      });
    }
    const at = iso(this.now());
    job.finishedAt = job.finishedAt ?? at;
    job.updatedAt = at;
    const snapshot: QueueJob = { ...job, transitions: [...job.transitions] };
    this.emit({ type: 'discarded', at, job: snapshot, reason });
    await this.store.delete(job.id);
    return snapshot;
  }

  async get(jobId: string): Promise<QueueJob | undefined> {
    return this.store.get(jobId);
  }

  async require(jobId: string): Promise<QueueJob> {
    const job = await this.store.get(jobId);
    if (!job) {
      throw new ShortformError(`job ${jobId} not found`, { code: 'VALIDATION' });
    }
    return job;
  }

  async list(state?: JobState): Promise<QueueJob[]> {
    const all = await this.store.all();
    return state ? all.filter((job) => job.state === state) : all;
  }

  /** Oldest due time among delayed jobs — the pool uses it to sleep precisely. */
  async nextDueAt(): Promise<number | null> {
    await this.hydrate();
    for (;;) {
      const next = this.delayed.peek();
      if (!next) return null;
      const job = await this.store.get(next.id);
      if (!job || job.state !== 'delayed' || msOf(job.availableAt) !== next.availableAtMs) {
        this.delayed.pop();
        continue;
      }
      return next.availableAtMs;
    }
  }

  async counts(): Promise<QueueCounts> {
    const counts: QueueCounts = {
      waiting: 0,
      delayed: 0,
      active: 0,
      completed: 0,
      failed: 0,
      dlq: 0,
    };
    for (const job of await this.store.all()) counts[job.state] += 1;
    return counts;
  }

  async stats(): Promise<QueueStats> {
    const jobs = await this.store.all();
    const counts = await this.counts();
    const latencies = jobs
      .filter((job) => job.state === 'completed' && job.startedAt && job.finishedAt)
      .map((job) => msOf(job.finishedAt) - msOf(job.startedAt))
      .filter((value) => Number.isFinite(value) && value >= 0)
      .sort((a, b) => a - b);
    const terminal = counts.completed + counts.failed + counts.dlq;
    const waiting = jobs.filter((job) => job.state === 'waiting');
    const oldestWaitingAgeMs =
      waiting.length === 0
        ? 0
        : Math.max(0, this.now() - Math.min(...waiting.map((job) => msOf(job.createdAt))));
    return {
      counts,
      total: jobs.length,
      successRate: terminal === 0 ? 0 : Math.round((counts.completed / terminal) * 10_000) / 10_000,
      meanLatencyMs: latencies.length === 0 ? 0 : Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length),
      p95LatencyMs:
        latencies.length === 0 ? 0 : latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95))],
      oldestWaitingAgeMs,
      retries: jobs.reduce((sum, job) => sum + Math.max(0, job.attempts - 1), 0),
    };
  }

  /** Retention: terminal jobs are kept for audit, then dropped by age. */
  async purgeTerminal(olderThanMs: number): Promise<number> {
    const cutoff = this.now() - olderThanMs;
    const terminal = (await this.store.all()).filter(
      (job) =>
        (job.state === 'completed' || job.state === 'failed' || job.state === 'dlq') &&
        job.finishedAt !== null &&
        msOf(job.finishedAt) < cutoff,
    );
    for (const job of terminal) await this.store.delete(job.id);
    return terminal.length;
  }
}
