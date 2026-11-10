import { ShortformError } from './errors';

export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Full jitter: delay = random() * ceiling. Avoids retry stampedes. */
  jitter?: boolean;
  /** Injected for tests; defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  onRetry?: (info: RetryEvent) => void;
  shouldRetry?: (error: unknown) => boolean;
}

export interface RetryEvent {
  label: string;
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  error: unknown;
}

export const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class RetryExhaustedError extends ShortformError {
  constructor(
    label: string,
    attempts: number,
    readonly lastError: unknown,
  ) {
    super(`${label} failed after ${attempts} attempts`, {
      code: 'NETWORK',
      retryable: false,
      details: { attempts, cause: lastError instanceof Error ? lastError.message : String(lastError) },
    });
    this.name = 'RetryExhaustedError';
  }
}

export function computeBackoffDelay(
  attempt: number,
  options: Pick<RetryOptions, 'baseDelayMs' | 'maxDelayMs' | 'jitter'>,
  random: () => number = Math.random,
): number {
  const base = options.baseDelayMs ?? 400;
  const max = options.maxDelayMs ?? 20_000;
  const ceiling = Math.min(max, base * 2 ** attempt);
  const jittered = options.jitter === false ? ceiling : random() * ceiling;
  return Math.max(0, Math.round(jittered));
}

/**
 * Retry with exponential backoff. `attempt` is zero-based: attempt 0 is the
 * first call. Non-retryable errors are rethrown immediately so an auth failure
 * does not burn five minutes of backoff before surfacing.
 */
export async function withRetry<T>(
  label: string,
  task: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const maxAttempts = options.attempts ?? 4;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  let lastError: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      return await task(attempt);
    } catch (error) {
      lastError = error;
      const retryable =
        options.shouldRetry?.(error) ??
        (error instanceof ShortformError ? error.retryable : true);
      if (!retryable || attempt === maxAttempts - 1) {
        throw error;
      }
      const delayMs = computeBackoffDelay(attempt, options, random);
      options.onRetry?.({
        label,
        attempt: attempt + 1,
        maxAttempts,
        delayMs,
        error,
      });
      await sleep(delayMs);
    }
  }
  throw new RetryExhaustedError(label, maxAttempts, lastError);
}

export interface QueueTask<T> {
  label: string;
  run: (attempt: number) => Promise<T>;
}

export interface QueueResult<T> {
  label: string;
  ok: boolean;
  value?: T;
  error?: string;
  attempts: number;
}

/**
 * Sequential retry queue used for platform calls: the Graph API and YouTube
 * both punish parallel bursts, so tasks run one at a time and a task that
 * fails is reported instead of aborting the whole batch.
 */
export class RetryQueue {
  private readonly results: QueueResult<unknown>[] = [];

  constructor(private readonly options: RetryOptions = {}) {}

  async run<T>(task: QueueTask<T>): Promise<QueueResult<T>> {
    let attempts = 0;
    try {
      const value = await withRetry(
        task.label,
        async (attempt) => {
          attempts = attempt + 1;
          return task.run(attempt);
        },
        this.options,
      );
      const result: QueueResult<T> = { label: task.label, ok: true, value, attempts };
      this.results.push(result as QueueResult<unknown>);
      return result;
    } catch (error) {
      const result: QueueResult<T> = {
        label: task.label,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        attempts,
      };
      this.results.push(result as QueueResult<unknown>);
      return result;
    }
  }

  get history(): QueueResult<unknown>[] {
    return [...this.results];
  }
}

/**
 * Token bucket. Instagram allows 25 API-published posts per rolling 24h and
 * YouTube's daily upload quota is 1600 units per video, so the engine meters
 * before it calls rather than discovering the limit as a 429.
 */
export class TokenBucket {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private readonly capacity: number,
    private readonly refillPerMs: number,
    private readonly now: () => number = Date.now,
  ) {
    this.tokens = capacity;
    this.lastRefill = now();
  }

  private refill(): void {
    const current = this.now();
    const elapsed = current - this.lastRefill;
    if (elapsed <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerMs);
    this.lastRefill = current;
  }

  tryConsume(count = 1): boolean {
    this.refill();
    if (this.tokens >= count) {
      this.tokens -= count;
      return true;
    }
    return false;
  }

  /** Milliseconds until `count` tokens are available. */
  msUntil(count = 1): number {
    this.refill();
    if (this.tokens >= count) return 0;
    return Math.ceil((count - this.tokens) / this.refillPerMs);
  }
}
