import { beforeEach, describe, expect, it } from 'vitest';
import { DailyQuota, RateLimitBucket } from '../src/lib/rateLimit/tokenBucket';
import { PROVIDER_PROFILES, TenantRegistry } from '../src/lib/rateLimit/tenantRegistry';

const START = Date.parse('2026-11-11T00:00:00.000Z');

function clock() {
  let now = START;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('token bucket', () => {
  let time: ReturnType<typeof clock>;
  let bucket: RateLimitBucket;
  beforeEach(() => {
    time = clock();
    bucket = new RateLimitBucket({ capacity: 5, refillPerSec: 0.2, now: time.now });
  });

  it('allows a burst up to capacity then refuses', () => {
    for (let index = 0; index < 5; index += 1) expect(bucket.tryConsume()).toBe(true);
    const refused = bucket.reserve();
    expect(refused.granted).toBe(false);
    expect(refused.remaining).toBe(0);
    expect(refused.retryAfterMs).toBe(5_000);
  });

  it('refills at the sustained rate', () => {
    for (let index = 0; index < 5; index += 1) bucket.tryConsume();
    time.advance(2_500);
    expect(bucket.available).toBeCloseTo(0.5, 5);
    expect(bucket.tryConsume()).toBe(false);
    time.advance(2_500);
    expect(bucket.tryConsume()).toBe(true);
  });

  it('never refills past capacity after a long idle period', () => {
    time.advance(10 * 60 * 60 * 1_000);
    expect(bucket.available).toBe(5);
  });

  it('is all-or-nothing for multi-unit reservations', () => {
    bucket.tryConsume(3);
    const decision = bucket.reserve(3);
    expect(decision.granted).toBe(false);
    expect(decision.remaining).toBe(2);
  });

  it('reports the wait for the requested units', () => {
    bucket.tryConsume(5);
    expect(bucket.msUntil(1)).toBe(5_000);
    expect(bucket.msUntil(2)).toBe(10_000);
  });

  it('holds every caller back after a 429 penalty', () => {
    bucket.penalize(30_000);
    expect(bucket.isBlocked).toBe(true);
    const decision = bucket.reserve();
    expect(decision.granted).toBe(false);
    expect(decision.retryAfterMs).toBe(30_000);
    time.advance(30_000);
    expect(bucket.tryConsume()).toBe(true);
  });

  it('exposes utilisation in a snapshot', () => {
    bucket.tryConsume(2);
    const snapshot = bucket.snapshot();
    expect(snapshot).toMatchObject({ capacity: 5, tokens: 3, refillPerSec: 0.2, utilization: 0.4 });
  });

  it('resets to full', () => {
    bucket.tryConsume(5);
    bucket.penalize(10_000);
    bucket.reset();
    expect(bucket.available).toBe(5);
    expect(bucket.isBlocked).toBe(false);
  });

  it('rejects invalid construction', () => {
    expect(() => new RateLimitBucket({ capacity: 0, refillPerSec: 1 })).toThrow(/capacity/);
    expect(() => new RateLimitBucket({ capacity: 1, refillPerSec: -1 })).toThrow(/refillPerSec/);
  });

  it('handles a zero-refill bucket without dividing by zero', () => {
    const frozen = new RateLimitBucket({ capacity: 2, refillPerSec: 0, now: time.now });
    expect(frozen.tryConsume()).toBe(true);
    expect(frozen.tryConsume()).toBe(true);
    expect(frozen.tryConsume()).toBe(false);
    expect(frozen.msUntil()).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('daily quota', () => {
  it('spends units until empty then resets at the window edge', () => {
    const time = clock();
    const quota = new DailyQuota({ limitUnits: 10, windowMs: 24 * 60 * 60 * 1_000, now: time.now });
    expect(quota.tryConsume(4)).toBe(true);
    expect(quota.remaining).toBe(6);
    expect(quota.tryConsume(7)).toBe(false);
    expect(quota.remaining).toBe(6);
    time.advance(24 * 60 * 60 * 1_000);
    expect(quota.remaining).toBe(10);
    expect(quota.tryConsume(10)).toBe(true);
  });

  it('reports the reset countdown', () => {
    const time = clock();
    const quota = new DailyQuota({ limitUnits: 5, windowMs: 60_000, now: time.now });
    time.advance(15_000);
    expect(quota.resetInMs).toBe(45_000);
  });

  it('rejects a non-positive limit and negative units', () => {
    expect(() => new DailyQuota({ limitUnits: 0 })).toThrow(/positive/);
    const quota = new DailyQuota({ limitUnits: 5 });
    expect(() => quota.tryConsume(-1)).toThrow(/>= 0/);
  });
});

describe('tenant rate-limit isolation', () => {
  it('exhausts one tenant’s Meta quota without touching another', () => {
    const time = clock();
    const registry = new TenantRegistry({ now: time.now });
    registry.register({ id: 'agency-a', name: 'Agency A', plan: 'agency' });
    registry.register({ id: 'creator-b', name: 'Creator B', plan: 'starter' });

    for (let index = 0; index < PROVIDER_PROFILES.meta.dailyUnits; index += 1) {
      expect(registry.consume('agency-a', 'meta').allowed).toBe(true);
    }
    const exhausted = registry.check('agency-a', 'meta');
    expect(exhausted.allowed).toBe(false);
    expect(exhausted.reason).toBe('quota-exhausted');
    expect(exhausted.quotaRemaining).toBe(0);

    const other = registry.consume('creator-b', 'meta');
    expect(other.allowed).toBe(true);
    expect(other.quotaRemaining).toBe(PROVIDER_PROFILES.meta.dailyUnits - 1);
  });

  it('meters YouTube uploads in data units, not calls', () => {
    const registry = new TenantRegistry({ now: clock().now });
    registry.register({ id: 't1', name: 'Tenant', plan: 'starter' });
    for (let index = 0; index < 6; index += 1) {
      const decision = registry.consume('t1', 'youtube');
      expect(decision.allowed).toBe(true);
      expect(decision.quotaRemaining).toBe(10_000 - 1_600 * (index + 1));
    }
    const seventh = registry.check('t1', 'youtube');
    expect(seventh.allowed).toBe(false);
    expect(seventh.reason).toBe('quota-exhausted');
    expect(seventh.quotaRemaining).toBe(400);
  });

  it('gives paid plans more burst headroom but the same hard daily cap', () => {
    const registry = new TenantRegistry({ now: clock().now });
    registry.register({ id: 'starter', name: 'Starter', plan: 'starter' });
    registry.register({ id: 'agency', name: 'Agency', plan: 'agency' });
    const view = registry.snapshot();
    const starter = view.find((entry) => entry.tenantId === 'starter')!;
    const agency = view.find((entry) => entry.tenantId === 'agency')!;
    const starterMeta = starter.providers.find((provider) => provider.provider === 'meta')!;
    const agencyMeta = agency.providers.find((provider) => provider.provider === 'meta')!;
    expect(agencyMeta.requestCapacity).toBeGreaterThan(starterMeta.requestCapacity);
    expect(agencyMeta.quotaLimit).toBe(starterMeta.quotaLimit);
  });

  it('honours contract overrides', () => {
    const registry = new TenantRegistry({ now: clock().now });
    registry.register({
      id: 'enterprise',
      name: 'Enterprise',
      plan: 'growth',
      overrides: { meta: { dailyUnits: 60, requestCapacity: 120 } },
    });
    const view = registry.snapshot().find((entry) => entry.tenantId === 'enterprise')!;
    const meta = view.providers.find((provider) => provider.provider === 'meta')!;
    expect(meta.quotaLimit).toBe(60);
    expect(meta.requestCapacity).toBe(120);
  });

  it('refuses a lease for an unknown tenant with a reason', () => {
    const registry = new TenantRegistry({ now: clock().now });
    const decision = registry.check('ghost', 'meta');
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('unknown-tenant');
    expect(() => registry.get('ghost')).toThrow(/unknown tenant/);
  });

  it('reports rate-limited after a platform penalty and clears when the penalty expires', () => {
    const time = clock();
    const registry = new TenantRegistry({ now: time.now });
    registry.register({ id: 't1', name: 'Tenant', plan: 'starter' });
    registry.penalize('t1', 'meta', 20_000);
    const blocked = registry.check('t1', 'meta');
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toBe('rate-limited');
    expect(blocked.retryAfterMs).toBe(20_000);
    time.advance(20_000);
    expect(registry.check('t1', 'meta').allowed).toBe(true);
  });

  it('never consumes a quota unit when the request bucket refuses', () => {
    const time = clock();
    const registry = new TenantRegistry({ now: time.now });
    registry.register({
      id: 't1',
      name: 'Tenant',
      plan: 'starter',
      overrides: { meta: { requestCapacity: 2, requestRefillPerSec: 0, dailyUnits: 25 } },
    });
    expect(registry.consume('t1', 'meta').allowed).toBe(true);
    expect(registry.consume('t1', 'meta').allowed).toBe(true);
    const refused = registry.consume('t1', 'meta');
    expect(refused.allowed).toBe(false);
    expect(refused.reason).toBe('rate-limited');
    expect(registry.check('t1', 'meta').quotaRemaining).toBe(23);
  });

  it('lists every registered tenant with both providers', () => {
    const registry = new TenantRegistry({ now: clock().now });
    registry.register({ id: 't1', name: 'One', plan: 'starter' });
    registry.register({ id: 't2', name: 'Two', plan: 'growth' });
    const snapshot = registry.snapshot();
    expect(snapshot).toHaveLength(2);
    expect(snapshot[0].providers.map((provider) => provider.provider)).toEqual(['meta', 'youtube']);
    expect(snapshot[0].providers[0].label).toBe('Meta Graph API');
  });
});
