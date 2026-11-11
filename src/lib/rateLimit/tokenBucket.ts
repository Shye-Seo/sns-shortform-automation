import { ShortformError } from '../errors';

export interface RateLimitBucketOptions {
  capacity: number;
  /** Steady-state refill. 0.2 = one request every five seconds. */
  refillPerSec: number;
  now?: () => number;
  /** Start full in production, partially drained in tests. */
  initialTokens?: number;
}

export interface BucketSnapshot {
  capacity: number;
  tokens: number;
  refillPerSec: number;
  /** 1 − tokens/capacity, rounded to 3 decimals. */
  utilization: number;
  blockedForMs: number;
}

export interface ConsumeDecision {
  granted: boolean;
  /** Tokens still available after the call (or now, when refused). */
  remaining: number;
  /** Milliseconds until the call could succeed. 0 when granted. */
  retryAfterMs: number;
}

/**
 * Token bucket with an explicit 429 penalty.
 *
 * Two knobs, not one: `capacity` absorbs a legitimate burst (a batch of 12
 * scheduled posts at 09:00), `refillPerSec` enforces the sustained rate the
 * platform actually measures. `penalize()` applies the platform's `Retry-After`
 * as a hard stop, because no amount of refill makes a 429 go away earlier.
 */
export class RateLimitBucket {
  private readonly capacity: number;
  private readonly refillPerSec: number;
  private readonly now: () => number;
  private tokens: number;
  private lastRefillMs: number;
  private blockedUntilMs = 0;

  constructor(options: RateLimitBucketOptions) {
    if (!Number.isFinite(options.capacity) || options.capacity <= 0) {
      throw new ShortformError('rate-limit capacity must be positive', {
        code: 'CONFIG',
        details: { capacity: options.capacity },
      });
    }
    if (!Number.isFinite(options.refillPerSec) || options.refillPerSec < 0) {
      throw new ShortformError('refillPerSec must be >= 0', {
        code: 'CONFIG',
        details: { refillPerSec: options.refillPerSec },
      });
    }
    this.capacity = options.capacity;
    this.refillPerSec = options.refillPerSec;
    this.now = options.now ?? Date.now;
    this.tokens = Math.min(this.capacity, Math.max(0, options.initialTokens ?? this.capacity));
    this.lastRefillMs = this.now();
  }

  private refill(): void {
    const current = this.now();
    const elapsed = current - this.lastRefillMs;
    if (elapsed <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + (elapsed / 1_000) * this.refillPerSec);
    this.lastRefillMs = current;
  }

  get available(): number {
    this.refill();
    return Math.floor(this.tokens * 1_000) / 1_000;
  }

  get isBlocked(): boolean {
    return this.now() < this.blockedUntilMs;
  }

  tryConsume(count = 1): boolean {
    return this.reserve(count).granted;
  }

  /** All-or-nothing: a multi-unit call never half-charges the bucket. */
  reserve(count = 1): ConsumeDecision {
    const amount = Math.max(0, count);
    this.refill();
    const blockedForMs = Math.max(0, this.blockedUntilMs - this.now());
    if (blockedForMs > 0) {
      return {
        granted: false,
        remaining: Math.floor(this.tokens * 1_000) / 1_000,
        retryAfterMs: Math.ceil(blockedForMs),
      };
    }
    if (this.tokens >= amount) {
      this.tokens -= amount;
      return { granted: true, remaining: Math.floor(this.tokens * 1_000) / 1_000, retryAfterMs: 0 };
    }
    const deficit = amount - this.tokens;
    const waitMs = this.refillPerSec === 0 ? Number.POSITIVE_INFINITY : Math.ceil((deficit / this.refillPerSec) * 1_000);
    return {
      granted: false,
      remaining: Math.floor(this.tokens * 1_000) / 1_000,
      retryAfterMs: Number.isFinite(waitMs) ? waitMs : 86_400_000,
    };
  }

  msUntil(count = 1): number {
    this.refill();
    if (this.isBlocked) return Math.max(0, this.blockedUntilMs - this.now());
    if (this.tokens >= count) return 0;
    if (this.refillPerSec === 0) return Number.POSITIVE_INFINITY;
    return Math.ceil(((count - this.tokens) / this.refillPerSec) * 1_000);
  }

  /** Honour a platform 429: hold every caller back for `retryAfterMs`. */
  penalize(retryAfterMs: number): void {
    const until = this.now() + Math.max(0, retryAfterMs);
    this.blockedUntilMs = Math.max(this.blockedUntilMs, until);
  }

  reset(): void {
    this.tokens = this.capacity;
    this.lastRefillMs = this.now();
    this.blockedUntilMs = 0;
  }

  snapshot(): BucketSnapshot {
    this.refill();
    return {
      capacity: this.capacity,
      tokens: Math.round(this.tokens * 1_000) / 1_000,
      refillPerSec: this.refillPerSec,
      utilization: Math.round((1 - this.tokens / this.capacity) * 1_000) / 1_000,
      blockedForMs: Math.max(0, this.blockedUntilMs - this.now()),
    };
  }
}

export interface DailyQuotaOptions {
  limitUnits: number;
  windowMs?: number;
  now?: () => number;
}

/**
 * Fixed-window daily budget. YouTube data units (10,000/day, 1,600 per upload)
 * are the reason this exists separately from the request bucket: the bucket
 * paces calls, the budget runs out at 6 uploads and does not refill until the
 * Pacific-midnight reset.
 */
export class DailyQuota {
  private readonly limitUnits: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  private usedUnits = 0;
  private windowStartMs: number;

  constructor(options: DailyQuotaOptions) {
    if (!Number.isFinite(options.limitUnits) || options.limitUnits <= 0) {
      throw new ShortformError('daily quota limit must be positive', {
        code: 'CONFIG',
        details: { limitUnits: options.limitUnits },
      });
    }
    this.limitUnits = options.limitUnits;
    this.windowMs = options.windowMs ?? 24 * 60 * 60 * 1_000;
    this.now = options.now ?? Date.now;
    this.windowStartMs = this.now();
  }

  private roll(): void {
    if (this.now() - this.windowStartMs >= this.windowMs) {
      this.windowStartMs = this.now();
      this.usedUnits = 0;
    }
  }

  get remaining(): number {
    this.roll();
    return Math.max(0, this.limitUnits - this.usedUnits);
  }

  get resetInMs(): number {
    this.roll();
    return Math.max(0, this.windowStartMs + this.windowMs - this.now());
  }

  tryConsume(units: number): boolean {
    this.roll();
    if (units < 0) throw new ShortformError('units must be >= 0', { code: 'VALIDATION' });
    if (this.usedUnits + units > this.limitUnits) return false;
    this.usedUnits += units;
    return true;
  }

  snapshot(): {limitUnits: number; usedUnits: number; remaining: number; resetInMs: number} {
    this.roll();
    return {
      limitUnits: this.limitUnits,
      usedUnits: this.usedUnits,
      remaining: Math.max(0, this.limitUnits - this.usedUnits),
      resetInMs: Math.max(0, this.windowStartMs + this.windowMs - this.now()),
    };
  }

  reset(): void {
    this.usedUnits = 0;
    this.windowStartMs = this.now();
  }
}
