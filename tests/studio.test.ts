import { beforeEach, describe, expect, it, vi } from 'vitest';
import { JobQueue } from '../src/lib/queue/jobQueue';
import { WorkerPool } from '../src/lib/queue/workerPool';
import { TenantRegistry } from '../src/lib/rateLimit/tenantRegistry';
import { OAuthTokenRotator } from '../src/lib/rateLimit/oauth';
import { TelemetryIngestor } from '../src/lib/telemetry/metrics';
import { generateHookVariants } from '../src/lib/telemetry/hooks';
import { StudioConsole } from '../src/services/studio/console';
import { StudioApi } from '../src/services/studio/api';
import { createDemoStudio } from '../src/services/studio/demo';
import type { Experiment } from '../src/types/telemetry';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CAPTURED = '2026-11-11T00:00:00.000Z';

function build() {
  const clock = Date.parse('2026-11-11T00:00:00.000Z');
  const queue = new JobQueue({
    now: () => clock,
    retry: { baseDelayMs: 5, maxDelayMs: 20, jitterRatio: 0, maxAttempts: 2 },
    idFactory: (() => {
      let index = 0;
      return () => `job_${++index}`;
    })(),
  });
  const tenants = new TenantRegistry({ now: () => clock });
  tenants.register({ id: 'agency-a', name: 'Agency A', plan: 'agency' });
  tenants.register({ id: 'creator-b', name: 'Creator B', plan: 'starter' });
  const rotator = new OAuthTokenRotator({
    refresher: vi.fn(async () => ({ accessToken: 'access-1', refreshToken: 'refresh-1', expiresInSec: 3_600 })),
    now: () => clock,
  });
  rotator.register({ tenantId: 'agency-a', platform: 'instagram-reels', refreshToken: 'refresh-0' });
  rotator.register({ tenantId: 'creator-b', platform: 'youtube-shorts', refreshToken: 'refresh-0' });
  const ingestor = new TelemetryIngestor({ now: () => clock });
  const console_ = new StudioConsole({
    queue,
    tenants,
    credentials: rotator,
    telemetry: ingestor,
    now: () => clock,
  });
  return { queue, tenants, rotator, ingestor, console: console_, api: new StudioApi(console_) };
}

function registerExperiment(console_: StudioConsole, ingestor: TelemetryIngestor) {
  const variants = generateHookVariants('주방 수납 정리', { count: 3 });
  const experiment: Experiment = {
    id: 'exp-kitchen',
    topic: '주방 수납 정리',
    variants,
    startedAt: CAPTURED,
    status: 'running',
  };
  console_.registerExperiment({ experiment, metric: 'retention', window: '24h', minSample: 200 });
  const rows: Array<[string, number, number]> = [
    ['A', 5_000, 2_000],
    ['B', 5_000, 3_100],
    ['C', 5_000, 2_100],
  ];
  for (const [variantId, impressions, completions] of rows) {
    ingestor.ingest({
      eventId: `evt-${variantId}`,
      experimentId: experiment.id,
      variantId,
      platform: 'instagram-reels',
      window: '24h',
      capturedAt: CAPTURED,
      impressions,
      views3s: 4_000,
      watchTimeSec: 30_000,
      completions,
      likes: 100,
      comments: 40,
      shares: 10,
      saves: 20,
      source: 'meta-webhook',
    });
  }
  return { experiment, variants };
}

describe('studio console snapshot', () => {
  let h: ReturnType<typeof build>;
  beforeEach(() => {
    h = build();
  });

  it('reports a healthy empty platform', async () => {
    const snapshot = await h.console.snapshot();
    expect(snapshot.health).toEqual({ status: 'ok', reasons: [] });
    expect(snapshot.queue.counts).toEqual({
      waiting: 0,
      delayed: 0,
      active: 0,
      completed: 0,
      failed: 0,
      dlq: 0,
    });
    expect(snapshot.tenants).toHaveLength(2);
    expect(snapshot.credentials).toHaveLength(2);
    expect(snapshot.generatedAt).toBe(new Date(Date.parse(CAPTURED)).toISOString());
  });

  it('summarises queue counts, latency and retries', async () => {
    const done = await h.queue.enqueue({ tenantId: 'agency-a', name: 'render' });
    await h.queue.reserve('worker-1');
    await h.queue.complete(done.id);
    const failed = await h.queue.enqueue({ tenantId: 'agency-a', name: 'broken' });
    await h.queue.reserve('worker-1');
    await h.queue.fail(failed.id, new Error('bad codec'), { retryable: false });

    const snapshot = await h.console.snapshot();
    expect(snapshot.queue.counts.completed).toBe(1);
    expect(snapshot.queue.counts.failed).toBe(1);
    expect(snapshot.queue.successRate).toBe(0.5);
    expect(snapshot.health.status).toBe('degraded');
  });

  it('marks the platform critical when the DLQ is growing', async () => {
    for (let index = 0; index < 3; index += 1) {
      const job = await h.queue.enqueue({ tenantId: 'agency-a', name: `render-${index}`, maxAttempts: 1 });
      await h.queue.reserve('worker-1');
      await h.queue.fail(job.id, new Error('exhausted'));
    }
    const snapshot = await h.console.snapshot();
    expect(snapshot.health.status).toBe('critical');
    expect(snapshot.health.reasons[0]).toMatch(/DLQ/);
    expect(snapshot.dlq).toHaveLength(3);
  });

  it('degrades on a single poisoned job rather than crying wolf', async () => {
    const job = await h.queue.enqueue({ tenantId: 'agency-a', name: 'render', maxAttempts: 1 });
    await h.queue.reserve('worker-1');
    await h.queue.fail(job.id, new Error('exhausted'));
    const snapshot = await h.console.snapshot();
    expect(snapshot.health.status).toBe('degraded');
    expect(snapshot.dlq[0]).toMatchObject({ jobId: job.id, tenantId: 'agency-a', attempts: 1, lastError: 'exhausted' });
  });

  it('degrades when a tenant has spent its daily quota', async () => {
    for (let index = 0; index < 25; index += 1) h.tenants.consume('agency-a', 'meta');
    const snapshot = await h.console.snapshot();
    expect(snapshot.health.status).toBe('degraded');
    expect(snapshot.health.reasons.join(' ')).toMatch(/quota exhausted/);
  });

  it('goes critical when a credential needs re-authorisation', async () => {
    h.rotator.markNeedsReauth('creator-b', 'youtube-shorts');
    const snapshot = await h.console.snapshot();
    expect(snapshot.health.status).toBe('critical');
    expect(snapshot.credentials.find((entry) => entry.tenantId === 'creator-b')?.status).toBe('needs-reauth');
  });

  it('includes worker load when a pool is attached', async () => {
    await h.queue.enqueue({
      tenantId: 'agency-a',
      name: 'render',
      payload: { projectId: 'p1', platform: 'instagram-reels', durationSec: 10, chunkCount: 2 },
    });
    const pool = new WorkerPool({
      queue: h.queue,
      size: 2,
      handler: async () => ({ ok: true }),
      now: h.console['now'],
    });
    await pool.drain();
    const consoleWithPool = new StudioConsole({
      queue: h.queue,
      tenants: h.tenants,
      workers: pool,
      credentials: undefined,
      telemetry: h.ingestor,
    });
    const snapshot = await consoleWithPool.snapshot();
    expect(snapshot.workers).toHaveLength(2);
    expect(snapshot.workers[0]).toMatchObject({ workerId: 'worker-1', state: 'idle' });
    expect(snapshot.workers.reduce((sum, worker) => sum + worker.jobsProcessed, 0)).toBe(1);
  });

  it('evaluates a registered experiment and names the winning hook', async () => {
    const { variants } = registerExperiment(h.console, h.ingestor);
    const snapshot = await h.console.snapshot();
    expect(snapshot.experiments).toHaveLength(1);
    const [experiment] = snapshot.experiments;
    expect(experiment.status).toBe('winner');
    expect(experiment.winner).toBe('B');
    expect(experiment.variants[0]).toMatchObject({ variantId: 'B', angle: variants[1].angle });
    expect(experiment.variants[0].value).toBeCloseTo(0.775, 3);
  });
});

describe('studio rendering', () => {
  let h: ReturnType<typeof build>;
  beforeEach(() => {
    h = build();
  });

  it('renders a terminal console with every section', async () => {
    const { variants } = registerExperiment(h.console, h.ingestor);
    void variants;
    const text = h.console.renderText(await h.console.snapshot());
    expect(text).toContain('STUDIO CONSOLE');
    expect(text).toContain('QUEUE');
    expect(text).toContain('TENANT RATE LIMITS');
    expect(text).toContain('Agency A');
    expect(text).toContain('OAUTH');
    expect(text).toContain('HOOK A/B');
    expect(text).toContain('winner: B');
    expect(text).toContain('█');
  });

  it('renders a self-contained HTML page and escapes hostile content', async () => {
    h.console.registerExperiment({
      experiment: {
        id: 'exp-xss',
        topic: '<script>alert(1)</script>',
        variants: generateHookVariants('주방 수납', { count: 2 }),
        startedAt: CAPTURED,
        status: 'running',
      },
    });
    const html = h.console.renderHtml(await h.console.snapshot());
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('shortform studio');
  });

  it('exports Prometheus metrics for queue, tenants and OAuth', async () => {
    const metrics = h.console.toPrometheus(await h.console.snapshot());
    expect(metrics).toContain('shortform_queue_jobs{state="waiting"} 0');
    expect(metrics).toContain('shortform_queue_success_rate 0');
    expect(metrics).toContain('shortform_tenant_quota_remaining{tenant="agency-a",provider="meta"} 25');
    expect(metrics).toContain('shortform_oauth_needs_reauth{tenant="agency-a",platform="instagram-reels"} 0');
  });
});

describe('demo studio state', () => {
  it('builds a reproducible platform state without network or ffmpeg', async () => {
    const demo = await createDemoStudio();
    const snapshot = await demo.console.snapshot();
    expect(snapshot.queue.counts).toMatchObject({ completed: 10, dlq: 1, failed: 1, delayed: 1 });
    expect(snapshot.queue.retries).toBe(3);
    expect(snapshot.experiments.find((entry) => entry.experimentId === 'exp-kitchen-hook')?.winner).toBe('B');
    expect(snapshot.experiments.find((entry) => entry.experimentId === 'exp-commute-hook')?.status).toBe('inconclusive');
    expect(snapshot.health.status).toBe('degraded');
    expect(demo.experiments).toHaveLength(2);
    expect(demo.tenants.list()).toHaveLength(3);
  });

  it('persists the demo backlog to a state file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'shortform-demo-'));
    const statePath = join(dir, 'state.json');
    try {
      const demo = await createDemoStudio({ statePath });
      expect((await demo.queue.list()).length).toBeGreaterThan(10);
      const raw = JSON.parse(await readFile(statePath, 'utf8')) as { jobs: Array<{ state: string }> };
      expect(raw.jobs.some((job) => job.state === 'dlq')).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('studio read API', () => {
  let h: ReturnType<typeof build>;
  beforeEach(() => {
    h = build();
  });

  it('serves health, queue, tenants and experiments', async () => {
    registerExperiment(h.console, h.ingestor);
    const health = await h.api.handle({ method: 'GET', path: '/v1/health' });
    expect(health).toMatchObject({ status: 200, contentType: 'application/json' });
    expect((health.body as { status: string }).status).toBe('ok');

    const queue = await h.api.handle({ method: 'GET', path: '/v1/queue' });
    expect(queue.status).toBe(200);
    expect(queue.body).toHaveProperty('counts');

    const tenants = await h.api.handle({ method: 'GET', path: '/v1/tenants' });
    expect((tenants.body as { items: unknown[] }).items).toHaveLength(2);

    const experiments = await h.api.handle({ method: 'GET', path: '/v1/experiments/exp-kitchen' });
    expect(experiments.status).toBe(200);
    expect((experiments.body as { winner: string }).winner).toBe('B');
  });

  it('serves tenant limits and 404s for an unknown tenant', async () => {
    const ok = await h.api.handle({ method: 'GET', path: '/v1/tenants/agency-a/limits' });
    expect(ok.status).toBe(200);
    expect((ok.body as { tenantId: string }).tenantId).toBe('agency-a');

    const missing = await h.api.handle({ method: 'GET', path: '/v1/tenants/ghost/limits' });
    expect(missing.status).toBe(404);
    expect(missing.body).toMatchObject({ error: 'tenant_not_found' });
  });

  it('serves the Prometheus endpoint as text', async () => {
    const response = await h.api.handle({ method: 'GET', path: '/v1/metrics' });
    expect(response.status).toBe(200);
    expect(response.contentType).toContain('text/plain');
    expect(String(response.body)).toContain('shortform_queue_jobs');
  });

  it('normalises trailing slashes and query strings', async () => {
    const response = await h.api.handle({ method: 'GET', path: '/v1/queue/?verbose=1' });
    expect(response.status).toBe(200);
  });

  it('returns 405 for a wrong method on a read route and 404 for unknown paths', async () => {
    // 읽기 라우트는 GET 전용이다. POST로 오면 경로가 아니라 메서드가 틀린 것이므로 405.
    const write = await h.api.handle({ method: 'POST', path: '/v1/snapshot' });
    expect(write.status).toBe(405);
    expect(write.headers?.allow).toBe('GET');

    // DLQ 조작은 POST /v1/queue/dlq/{id}/{retry|discard} 두 가지뿐이다.
    // 예전 CLI 동사(replay)는 조작 API가 아니므로 "알 수 없는 동작"으로 거부된다.
    const legacyVerb = await h.api.handle({ method: 'POST', path: '/v1/queue/dlq/job_1/replay' });
    expect(legacyVerb.status).toBe(404);
    expect(legacyVerb.body).toMatchObject({ error: 'unknown_dlq_action' });

    const unknown = await h.api.handle({ method: 'GET', path: '/v1/nope' });
    expect(unknown.status).toBe(404);
    expect(unknown.body).toMatchObject({ error: 'not_found' });
  });

  it('lists DLQ entries with a count', async () => {
    const job = await h.queue.enqueue({ tenantId: 'agency-a', name: 'doomed', maxAttempts: 1 });
    await h.queue.reserve('worker-1');
    await h.queue.fail(job.id, new Error('boom'));
    const response = await h.api.handle({ method: 'GET', path: '/v1/queue/dlq' });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ count: 1 });
  });
});
