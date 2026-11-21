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
  /**
   * 리셋 방식.
   *
   * - `rolling` (기본): 지난 24시간 안에 쓴 양만 센다. Meta의 콘텐츠 발행 한도가 이 방식이다.
   * - `calendar-day`: 시간대의 자정에 한 번에 0으로 돌아간다. YouTube Data API의 일일 할당량이
   *   태평양 자정(PT) 기준이다.
   *
   * 고정 창(프로세스가 켜진 시각부터 24시간)을 기본값으로 두지 않는 이유: 재시작할 때마다
   * 리셋 시각이 달라져서, 같은 하루에 두 번 한도가 차는 일이 생긴다.
   */
  reset?: 'rolling' | 'calendar-day';
  /** calendar-day일 때 기준 시간대(IANA). 기본 Asia/Seoul. */
  timeZone?: string;
}

function zonedParts(ms: number, timeZone: string): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(ms));
  const pick = (type: string): number => Number(parts.find((part) => part.type === type)?.value ?? '0');
  return { year: pick('year'), month: pick('month'), day: pick('day') };
}

/** 해당 시간대의 UTC 오프셋(ms). DST가 있는 지역도 그 시점의 오프셋을 돌려준다. */
function zoneOffsetMs(ms: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(ms));
  const pick = (type: string): number => Number(parts.find((part) => part.type === type)?.value ?? '0');
  const hour = pick('hour') === 24 ? 0 : pick('hour');
  const asUtc = Date.UTC(pick('year'), pick('month') - 1, pick('day'), hour, pick('minute'), pick('second'));
  return asUtc - ms;
}

/** 그 시간대에서 오늘 0시에 해당하는 순간(epoch ms). */
function startOfZonedDay(ms: number, timeZone: string): number {
  const { year, month, day } = zonedParts(ms, timeZone);
  let guess = Date.UTC(year, month - 1, day, 0, 0, 0);
  // 오프셋을 한 번 더 적용해야 DST 경계에서도 정확하다.
  for (let pass = 0; pass < 2; pass += 1) guess = Date.UTC(year, month - 1, day, 0, 0, 0) - zoneOffsetMs(guess, timeZone);
  return guess;
}

/** 그 시간대의 다음 0시. */
function nextZonedMidnight(ms: number, timeZone: string): number {
  const start = startOfZonedDay(ms, timeZone);
  // 26시간을 더해 '다음 날'의 날짜 부분을 얻는다(자정 직후에도 안전).
  const { year, month, day } = zonedParts(start + 26 * 3_600_000, timeZone);
  let guess = Date.UTC(year, month - 1, day, 0, 0, 0);
  for (let pass = 0; pass < 2; pass += 1) guess = Date.UTC(year, month - 1, day, 0, 0, 0) - zoneOffsetMs(guess, timeZone);
  return guess;
}

/**
 * 일일 예산. 요청 버킷과 분리해 둔 이유는 회복 방식이 다르기 때문이다 — 버킷은 몇 초면
 * 차지만 예산은 24시간 또는 플랫폼의 자정까지 기다려야 한다.
 */
export class DailyQuota {
  private readonly limitUnits: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly reset: 'rolling' | 'calendar-day';
  private readonly timeZone: string;
  /** rolling 모드에서만 쓰는 사용 기록(24시간이 지난 기록은 버린다). */
  private charges: Array<{ at: number; units: number }> = [];
  private usedWindowUnits = 0;
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
    this.reset = options.reset ?? 'rolling';
    this.timeZone = options.timeZone ?? 'Asia/Seoul';
    this.windowStartMs = this.reset === 'calendar-day' ? startOfZonedDay(this.now(), this.timeZone) : this.now();
  }

  private pruneRolling(nowMs: number): void {
    const cutoff = nowMs - this.windowMs;
    if (this.charges.length > 0 && this.charges[0]!.at <= cutoff) {
      this.charges = this.charges.filter((charge) => charge.at > cutoff);
    }
    this.usedWindowUnits = this.charges.reduce((sum, charge) => sum + charge.units, 0);
  }

  /** 날짜가 바뀌었으면(calendar-day) 사용량을 0으로 되돌린다. */
  private roll(): void {
    const nowMs = this.now();
    if (this.reset === 'rolling') {
      this.pruneRolling(nowMs);
      return;
    }
    const todayStart = startOfZonedDay(nowMs, this.timeZone);
    if (todayStart !== this.windowStartMs) {
      this.windowStartMs = todayStart;
      this.usedWindowUnits = 0;
    }
  }

  private get usedUnits(): number {
    return this.usedWindowUnits;
  }

  get remaining(): number {
    this.roll();
    return Math.max(0, this.limitUnits - this.usedUnits);
  }

  /** 한도가 다시 채워지기까지 남은 시간. 아직 쓴 것이 없으면 리셋할 것도 없다(0). */
  get resetInMs(): number {
    this.roll();
    if (this.remaining >= this.limitUnits) return 0;
    if (this.reset === 'calendar-day') {
      return Math.max(0, nextZonedMidnight(this.now(), this.timeZone) - this.now());
    }
    const oldest = this.charges[0];
    if (!oldest) return 0;
    return Math.max(0, oldest.at + this.windowMs - this.now());
  }

  tryConsume(units: number): boolean {
    this.roll();
    if (units < 0) throw new ShortformError('units must be >= 0', { code: 'VALIDATION' });
    if (this.usedUnits + units > this.limitUnits) return false;
    if (units > 0) {
      if (this.reset === 'rolling') this.charges.push({ at: this.now(), units });
      this.usedWindowUnits += units;
    }
    return true;
  }

  snapshot(): { limitUnits: number; usedUnits: number; remaining: number; resetInMs: number } {
    this.roll();
    return {
      limitUnits: this.limitUnits,
      usedUnits: this.usedUnits,
      remaining: Math.max(0, this.limitUnits - this.usedUnits),
      resetInMs: this.resetInMs,
    };
  }

  resetQuota(): void {
    this.charges = [];
    this.usedWindowUnits = 0;
    this.windowStartMs = this.reset === 'calendar-day' ? startOfZonedDay(this.now(), this.timeZone) : this.now();
  }
}
