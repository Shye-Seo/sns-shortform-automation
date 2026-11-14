import { JobQueue } from '../../src/lib/queue/jobQueue';
import { planPublishSlots } from '../../src/lib/rateLimit/jitter';
import { PROVIDER_PROFILES, TenantRegistry, type ProviderId } from '../../src/lib/rateLimit/tenantRegistry';
import { DlqActionService, type DlqActionRecord } from '../../src/services/studio/dlqActions';
import type { QueueJob } from '../../src/types/queue';

/**
 * Publishing calendar, daily quota gauges and the DLQ retry loop.
 *
 * The numbers come from the platform modules the worker uses:
 * - `planPublishSlots` spreads uploads across the window with jitter;
 * - `TenantRegistry` owns the per-tenant daily budget (Meta 25 posts/24h,
 *   YouTube 10,000 units/day at 1,600 per upload);
 * - `JobQueue` + `DlqActionService` decide whether a failed job is replayed,
 *   and record who asked.
 *
 * The demo presses those buttons; it does not re-implement them.
 */

export type Channel = 'instagram-reels' | 'youtube-shorts';

export interface SlotView {
  id: string;
  atMs: number;
  channel: Channel;
  tenantId: string;
  title: string;
  state: 'scheduled' | 'published' | 'blocked';
  reason?: string;
}

export interface DlqRow {
  id: string;
  name: string;
  state: string;
  kind: string;
  attempts: number;
  maxAttempts: number;
  error: string | null;
  transitions: number;
}

export interface QuotaView {
  tenantId: string;
  name: string;
  plan: string;
  providers: Array<{
    provider: ProviderId;
    label: string;
    /** Units consumed today out of the platform's daily budget. */
    used: number;
    limit: number;
    unitCost: number;
    publishesLeft: number;
    resetInMs: number;
    requestRemaining: number;
    requestCapacity: number;
  }>;
}

const TENANTS = [
  { id: 'agency-morning', name: '모닝픽쳐스', plan: 'agency' as const },
  { id: 'creator-bom', name: '봄날의기록', plan: 'growth' as const },
];

const PROVIDER_OF: Record<Channel, ProviderId> = {
  'instagram-reels': 'meta',
  'youtube-shorts': 'youtube',
};

const TITLES = [
  '3평 주방 수납 3단계',
  '실업급여 신청 순서',
  '겨울 코트 컬러 고르기',
  '신혼집 수납 그릇 정리',
  '부산 전포 카페 리스트',
  '주방 서랍 10분 정리',
  '퇴사 후 첫 달 정리',
  '겨울 이불 보관법',
];

function seeded(seed = 20261114): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

/** 09:00–22:00 in the viewer's timezone, as epoch ms. */
function dayWindow(nowMs: number): { start: number; end: number } {
  const date = new Date(nowMs);
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 9, 0, 0, 0).getTime();
  const end = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 22, 0, 0, 0).getTime();
  return { start, end };
}

export class PublishDesk {
  tenants: TenantRegistry;

  queue: JobQueue;

  dlq: DlqActionService;

  slots: SlotView[] = [];

  actions: DlqActionRecord[] = [];

  private readonly now: () => number;

  private readonly random = seeded();

  private jobSeq = 0;

  constructor(now: () => number = Date.now) {
    this.now = now;
    this.tenants = new TenantRegistry({ now });
    for (const tenant of TENANTS) this.tenants.register(tenant);

    // Today's usage: a busy morning. YouTube is at 4 of 6 uploads, so the
    // gauge has somewhere to run out while the operator watches.
    for (let index = 0; index < 21; index += 1) this.tenants.consume('agency-morning', 'meta');
    for (let index = 0; index < 4; index += 1) this.tenants.consume('agency-morning', 'youtube');
    for (let index = 0; index < 3; index += 1) this.tenants.consume('creator-bom', 'meta');

    this.queue = new JobQueue({
      now,
      random: seeded(7),
      retry: { baseDelayMs: 1, maxDelayMs: 2, jitterRatio: 0, maxAttempts: 1 },
      idFactory: () => `pub_${String(++this.jobSeq).padStart(3, '0')}`,
    });
    this.dlq = new DlqActionService({ queue: this.queue, now });
    this.slots = this.planDay();
  }

  /** Build the day's queue with the engine's jittered slot planner. */
  planDay(): SlotView[] {
    const { start, end } = dayWindow(this.now());
    const made: SlotView[] = [];

    const instagram = planPublishSlots({
      count: 8,
      windowStartMs: start,
      windowEndMs: end,
      minGapMs: 45 * 60_000,
      leadMs: 20 * 60_000,
      random: this.random,
    });
    const youtube = planPublishSlots({
      count: 3,
      windowStartMs: start + 3_600_000,
      windowEndMs: end,
      minGapMs: 90 * 60_000,
      leadMs: 40 * 60_000,
      random: this.random,
    });

    instagram.forEach((slot, index) => {
      made.push({
        id: `ig-${index + 1}`,
        atMs: slot.atMs,
        channel: 'instagram-reels',
        tenantId: 'agency-morning',
        title: TITLES[index % TITLES.length]!,
        state: 'scheduled',
      });
    });
    youtube.forEach((slot, index) => {
      made.push({
        id: `yt-${index + 1}`,
        atMs: slot.atMs,
        channel: 'youtube-shorts',
        tenantId: 'agency-morning',
        title: TITLES[(index + 5) % TITLES.length]!,
        state: 'scheduled',
      });
    });

    return made.sort((a, b) => a.atMs - b.atMs);
  }

  /** Publish the earliest scheduled slot: charge the quota, or explain the refusal. */
  publishNext(): SlotView | null {
    const slot = this.slots.find((item) => item.state === 'scheduled');
    if (!slot) return null;

    const provider = PROVIDER_OF[slot.channel];
    const decision = this.tenants.consume(slot.tenantId, provider);
    if (!decision.allowed) {
      const reason =
        decision.reason === 'quota-exhausted'
          ? `${PROVIDER_PROFILES[provider].label} 일일 한도 소진 (${decision.quotaRemaining}/${decision.quotaLimit}) — ${Math.round(decision.quotaResetInMs / 60_000)}분 뒤 초기화`
          : '요청 버킷 소진 — 잠시 뒤 재시도';
      const blocked: SlotView = { ...slot, state: 'blocked', reason };
      this.slots = this.slots.map((item) => (item.id === slot.id ? blocked : item));
      void this.failJob(slot, reason);
      return blocked;
    }

    const published: SlotView = { ...slot, state: 'published' };
    this.slots = this.slots.map((item) => (item.id === slot.id ? published : item));
    return published;
  }

  /** A refused publish is a real queue failure, so it lands in the DLQ path. */
  private async failJob(slot: SlotView, reason: string): Promise<void> {
    const job = await this.queue.enqueue({
      tenantId: slot.tenantId,
      name: `publish ${slot.title}`,
      kind: 'publish',
      maxAttempts: 1,
      priority: 6,
    });
    const reserved = await this.queue.reserve('worker-demo');
    if (reserved) await this.queue.fail(reserved.id, new Error(reason), { retryable: true });
    void job;
  }

  /** Seed the queue with the three outcomes an operator actually sees. */
  async seedJobs(): Promise<void> {
    const cases: Array<{ name: string; outcome: 'complete' | 'dlq' | 'failed' }> = [
      { name: 'render 3평 주방 수납 3단계', outcome: 'complete' },
      { name: 'render 실업급여 신청 순서', outcome: 'dlq' },
      { name: 'upload 겨울 코트 컬러 고르기', outcome: 'failed' },
    ];

    for (const item of cases) {
      await this.queue.enqueue({
        tenantId: 'agency-morning',
        name: item.name,
        kind: item.outcome === 'failed' ? 'publish' : 'render',
        maxAttempts: 1,
        priority: 5,
      });
      const job = await this.queue.reserve('worker-demo');
      if (!job) continue;
      if (item.outcome === 'complete') {
        await this.queue.complete(job.id, { ok: true });
      } else if (item.outcome === 'dlq') {
        await this.queue.fail(job.id, new Error('ffmpeg exited with code 1 (out of memory)'), { retryable: true });
      } else {
        await this.queue.fail(job.id, new Error('Meta Graph API 400: video duration over platform limit'), {
          retryable: false,
        });
      }
    }
  }

  async retry(jobId: string): Promise<{ ok: boolean; message: string }> {
    const outcome = await this.dlq.retry(jobId, 'studio-console');
    this.actions = this.dlq.recent(8);
    if (outcome.ok) {
      // A replayed job is waiting again; the console shows the new state.
      const job = await this.queue.get(jobId);
      if (job && job.state === 'waiting') {
        const reserved = await this.queue.reserve(`worker-${this.jobSeq % 3}`);
        if (reserved && reserved.id === jobId) await this.queue.complete(jobId, { retried: true });
      }
    }
    return { ok: outcome.ok, message: outcome.message };
  }

  async discard(jobId: string): Promise<{ ok: boolean; message: string }> {
    const outcome = await this.dlq.discard(jobId, 'studio-console');
    this.actions = this.dlq.recent(8);
    return { ok: outcome.ok, message: outcome.message };
  }

  async rows(): Promise<DlqRow[]> {
    const jobs: QueueJob[] = await this.queue.list();
    return jobs
      .filter((job) => job.state === 'dlq' || job.state === 'failed')
      .map((job) => ({
        id: job.id,
        name: job.name,
        state: job.state,
        kind: job.kind,
        attempts: job.attempts,
        maxAttempts: job.maxAttempts,
        error: job.lastError,
        transitions: job.transitions.length,
      }));
  }

  quotas(): QuotaView[] {
    return this.tenants.list().map((tenant) => ({
      tenantId: tenant.id,
      name: tenant.name,
      plan: tenant.plan,
      providers: (['meta', 'youtube'] as ProviderId[]).map((provider) => {
        const view = this.tenants.check(tenant.id, provider);
        const profile = PROVIDER_PROFILES[provider];
        return {
          provider,
          label: profile.label,
          used: view.quotaLimit - view.quotaRemaining,
          limit: view.quotaLimit,
          unitCost: profile.unitCost,
          publishesLeft: Math.floor(view.quotaRemaining / profile.unitCost),
          resetInMs: view.quotaResetInMs,
          requestRemaining: view.requestRemaining,
          requestCapacity: view.requestCapacity,
        };
      }),
    }));
  }

  async counts(): Promise<Record<string, number>> {
    return this.queue.counts();
  }
}
