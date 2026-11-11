import { z } from 'zod';
import { ShortformError } from '../errors';
import { DailyQuota, RateLimitBucket } from './tokenBucket';

export const ProviderIdSchema = z.enum(['meta', 'youtube']);
export type ProviderId = z.infer<typeof ProviderIdSchema>;

export const TenantPlanSchema = z.enum(['starter', 'growth', 'agency']);
export type TenantPlan = z.infer<typeof TenantPlanSchema>;

export interface ProviderProfile {
  label: string;
  /** Concurrent burst a single tenant may fire. */
  requestCapacity: number;
  /** Sustained calls per second. */
  requestRefillPerSec: number;
  /** Platform daily budget in the provider's own units. */
  dailyUnits: number;
  /** Cost of one publish in those units. */
  unitCost: number;
}

/**
 * Platform limits, encoded once.
 *
 * - Meta: a Reels publish is 1 unit against the 25-per-24h content publishing
 *   limit; requests are paced well under the per-user call limit.
 * - YouTube Data API v3: 10,000 units/day, and `videos.insert` is 1,600 units,
 *   so six uploads exhaust the day. That is why a queue, not a loop, owns this.
 */
export const PROVIDER_PROFILES: Record<ProviderId, ProviderProfile> = {
  meta: {
    label: 'Meta Graph API',
    requestCapacity: 30,
    requestRefillPerSec: 0.2,
    dailyUnits: 25,
    unitCost: 1,
  },
  youtube: {
    label: 'YouTube Data API v3',
    requestCapacity: 20,
    requestRefillPerSec: 0.1,
    dailyUnits: 10_000,
    unitCost: 1_600,
  },
};

/** Paid plans raise burst headroom, never the platform's hard daily cap. */
export const PLAN_HEADROOM: Record<TenantPlan, number> = {
  starter: 1,
  growth: 1.5,
  agency: 2.5,
};

export const TenantInputSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(120),
  plan: TenantPlanSchema.default('starter'),
  seatCount: z.number().int().min(1).max(500).default(1),
  /** Per-tenant overrides for contract customers. */
  overrides: z
    .object({
      meta: z
        .object({
          requestCapacity: z.number().positive().optional(),
          requestRefillPerSec: z.number().min(0).optional(),
          dailyUnits: z.number().positive().optional(),
        })
        .partial()
        .optional(),
      youtube: z
        .object({
          requestCapacity: z.number().positive().optional(),
          requestRefillPerSec: z.number().min(0).optional(),
          dailyUnits: z.number().positive().optional(),
        })
        .partial()
        .optional(),
    })
    .partial()
    .optional(),
});
export type TenantInput = z.input<typeof TenantInputSchema>;

export interface Tenant {
  id: string;
  name: string;
  plan: TenantPlan;
  seatCount: number;
  createdAt: string;
  overrides?: TenantInput['overrides'];
}

export type LimitReason = 'unknown-tenant' | 'rate-limited' | 'quota-exhausted';

export interface LimitDecision {
  tenantId: string;
  provider: ProviderId;
  allowed: boolean;
  reason: LimitReason | null;
  requestRemaining: number;
  requestCapacity: number;
  quotaRemaining: number;
  quotaLimit: number;
  quotaResetInMs: number;
  retryAfterMs: number;
}

export interface TenantLimitView {
  tenantId: string;
  name: string;
  plan: TenantPlan;
  providers: Array<{
    provider: ProviderId;
    label: string;
    requestRemaining: number;
    requestCapacity: number;
    utilization: number;
    quotaRemaining: number;
    quotaLimit: number;
    quotaResetInMs: number;
    blockedForMs: number;
  }>;
}

interface TenantRuntime {
  record: Tenant;
  buckets: Record<ProviderId, RateLimitBucket>;
  quotas: Record<ProviderId, DailyQuota>;
}

/**
 * One registry for every creator and agency account on the platform.
 *
 * Isolation is structural, not a convention: buckets and quotas live inside
 * each tenant's runtime, so a viral day for tenant A cannot delay tenant B by
 * even one slot. This is the multi-tenant half of the rate limiter, and the
 * reason a shared global bucket would be a bug rather than an optimisation.
 */
export class TenantRegistry {
  private readonly now: () => number;
  private readonly profiles: Record<ProviderId, ProviderProfile>;
  private readonly tenants = new Map<string, TenantRuntime>();

  constructor(options: { now?: () => number; profiles?: Record<ProviderId, ProviderProfile> } = {}) {
    this.now = options.now ?? Date.now;
    this.profiles = options.profiles ?? PROVIDER_PROFILES;
  }

  register(input: TenantInput): Tenant {
    const parsed = TenantInputSchema.parse(input);
    const headroom = PLAN_HEADROOM[parsed.plan];
    const record: Tenant = {
      id: parsed.id,
      name: parsed.name,
      plan: parsed.plan,
      seatCount: parsed.seatCount,
      createdAt: new Date(this.now()).toISOString(),
      overrides: parsed.overrides,
    };
    const buckets = {} as Record<ProviderId, RateLimitBucket>;
    const quotas = {} as Record<ProviderId, DailyQuota>;
    for (const provider of ProviderIdSchema.options) {
      const profile = this.profiles[provider];
      const override = parsed.overrides?.[provider];
      buckets[provider] = new RateLimitBucket({
        capacity: override?.requestCapacity ?? Math.round(profile.requestCapacity * headroom),
        refillPerSec: override?.requestRefillPerSec ?? profile.requestRefillPerSec * headroom,
        now: this.now,
      });
      quotas[provider] = new DailyQuota({
        limitUnits: override?.dailyUnits ?? profile.dailyUnits,
        now: this.now,
      });
    }
    this.tenants.set(record.id, { record, buckets, quotas });
    return record;
  }

  has(tenantId: string): boolean {
    return this.tenants.has(tenantId);
  }

  get(tenantId: string): Tenant {
    const runtime = this.tenants.get(tenantId);
    if (!runtime) {
      throw new ShortformError(`unknown tenant: ${tenantId}`, {
        code: 'VALIDATION',
        details: { tenantId },
      });
    }
    return runtime.record;
  }

  list(): Tenant[] {
    return [...this.tenants.values()].map((runtime) => runtime.record);
  }

  /** Non-destructive check: what would `consume` decide right now? */
  check(tenantId: string, provider: ProviderId, units?: number): LimitDecision {
    const runtime = this.tenants.get(tenantId);
    const profile = this.profiles[provider];
    const cost = units ?? profile.unitCost;
    if (!runtime) {
      return {
        tenantId,
        provider,
        allowed: false,
        reason: 'unknown-tenant',
        requestRemaining: 0,
        requestCapacity: 0,
        quotaRemaining: 0,
        quotaLimit: 0,
        quotaResetInMs: 0,
        retryAfterMs: 0,
      };
    }
    const bucket = runtime.buckets[provider];
    const quota = runtime.quotas[provider];
    const quotaView = quota.snapshot();
    const bucketView = bucket.snapshot();
    const quotaOk = quotaView.remaining >= cost;
    const rateOk = bucketView.blockedForMs === 0 && bucketView.tokens >= 1;
    return {
      tenantId,
      provider,
      allowed: quotaOk && rateOk,
      reason: !quotaOk ? 'quota-exhausted' : !rateOk ? 'rate-limited' : null,
      requestRemaining: bucketView.tokens,
      requestCapacity: bucketView.capacity,
      quotaRemaining: quotaView.remaining,
      quotaLimit: quotaView.limitUnits,
      quotaResetInMs: quotaView.resetInMs,
      retryAfterMs: !quotaOk ? quotaView.resetInMs : bucket.msUntil(1),
    };
  }

  /**
   * Charge one request and its units atomically: either both counters move or
   * neither does, so a refused call never eats a tenant's daily budget.
   */
  consume(tenantId: string, provider: ProviderId, units?: number): LimitDecision {
    const runtime = this.tenants.get(tenantId);
    const profile = this.profiles[provider];
    const cost = units ?? profile.unitCost;
    const before = this.check(tenantId, provider, cost);
    if (!before.allowed) return before;

    const quota = runtime!.quotas[provider];
    const bucket = runtime!.buckets[provider];
    const charged = quota.tryConsume(cost);
    const granted = bucket.reserve(1);
    if (!charged || !granted.granted) {
      // Defensive: check-then-commit under a single writer cannot reach here.
      throw new ShortformError('rate-limit accounting diverged', {
        code: 'EXTERNAL',
        details: { tenantId, provider, charged, granted },
      });
    }
    // `check` describes the *next* call; this decision describes the one that
    // just succeeded, so a charge that empties the bucket or the daily budget
    // is still reported as allowed.
    return { ...this.check(tenantId, provider, cost), allowed: true, reason: null, retryAfterMs: 0 };
  }

  penalize(tenantId: string, provider: ProviderId, retryAfterMs: number): void {
    const runtime = this.tenants.get(tenantId);
    if (!runtime) return;
    runtime.buckets[provider].penalize(retryAfterMs);
  }

  snapshot(): TenantLimitView[] {
    return [...this.tenants.values()].map(({ record, buckets, quotas }) => ({
      tenantId: record.id,
      name: record.name,
      plan: record.plan,
      providers: ProviderIdSchema.options.map((provider) => {
        const bucket = buckets[provider].snapshot();
        const quota = quotas[provider].snapshot();
        return {
          provider,
          label: this.profiles[provider].label,
          requestRemaining: Math.floor(bucket.tokens),
          requestCapacity: bucket.capacity,
          utilization: bucket.utilization,
          quotaRemaining: quota.remaining,
          quotaLimit: quota.limitUnits,
          quotaResetInMs: quota.resetInMs,
          blockedForMs: bucket.blockedForMs,
        };
      }),
    }));
  }
}
