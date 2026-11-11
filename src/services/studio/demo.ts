import { FileQueueStore } from '../../lib/queue/fileStore';
import { JobQueue } from '../../lib/queue/jobQueue';
import { createSimulatedRenderHandler } from '../../lib/queue/renderJob';
import { WorkerPool } from '../../lib/queue/workerPool';
import { OAuthTokenRotator } from '../../lib/rateLimit/oauth';
import { TenantRegistry } from '../../lib/rateLimit/tenantRegistry';
import { generateHookVariants } from '../../lib/telemetry/hooks';
import { TelemetryIngestor } from '../../lib/telemetry/metrics';
import type { Experiment, HookVariant, MetricWindow } from '../../types/telemetry';
import { StudioConsole } from './console';
import { DlqActionService } from './dlqActions';

export interface DemoStudioOptions {
  statePath?: string;
  now?: () => number;
}

export interface DemoStudio {
  queue: JobQueue;
  tenants: TenantRegistry;
  rotator: OAuthTokenRotator;
  ingestor: TelemetryIngestor;
  console: StudioConsole;
  experiments: Experiment[];
}

const TENANTS = [
  { id: 'agency-morning', name: '모닝픽쳐스 (대행사)', plan: 'agency' as const },
  { id: 'creator-bom', name: '봄날의기록', plan: 'growth' as const },
  { id: 'studio-ddam', name: '따뜻한스튜디오', plan: 'starter' as const },
];

function seeded(seed = 20261111): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

/**
 * A reproducible, network-free platform state for the console demo:
 * 12 render jobs across three tenants, a retry that succeeded, one exhausted
 * retry in the DLQ, one non-retryable failure, varied tenant quotas, and two
 * hook experiments (one decided, one inconclusive).
 *
 * `studio --demo` prints this without touching GitHub, Meta or ffmpeg, which is
 * what makes the screenshot in the README verifiable by anyone who clones.
 */
export async function createDemoStudio(options: DemoStudioOptions = {}): Promise<DemoStudio> {
  // Wall-clock timing with real short sleeps: the run finishes in under a
  // second, but the console shows honest latencies and worker utilisation
  // instead of the 0ms/100% a fully simulated clock would print.
  const now = options.now ?? Date.now;
  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
  const random = seeded();
  let sequence = 0;
  const store = options.statePath ? new FileQueueStore(options.statePath) : undefined;
  if (store) await store.clear();

  const queue = new JobQueue({
    store,
    now,
    random,
    retry: { baseDelayMs: 5, maxDelayMs: 20, jitterRatio: 0, maxAttempts: 3 },
    idFactory: () => `job_${String(++sequence).padStart(3, '0')}`,
  });

  const tenants = new TenantRegistry({ now });
  for (const tenant of TENANTS) tenants.register(tenant);

  const rotator = new OAuthTokenRotator({
    now,
    refresher: async ({ tenantId, platform }) => ({
      accessToken: `demo-access-${tenantId}-${platform}`,
      refreshToken: `demo-refresh-${tenantId}-${platform}`,
      expiresInSec: 3_600,
      scopes: ['content_publish'],
    }),
  });
  rotator.register({
    tenantId: 'agency-morning',
    platform: 'instagram-reels',
    refreshToken: 'demo-refresh-1',
    accessToken: 'demo-access-1',
    expiresAtMs: now() + 42 * 60 * 1_000,
    scopes: ['instagram_content_publish', 'instagram_basic'],
  });
  rotator.register({
    tenantId: 'agency-morning',
    platform: 'youtube-shorts',
    refreshToken: 'demo-refresh-2',
    accessToken: 'demo-access-2',
    expiresAtMs: now() + 51 * 60 * 1_000,
    scopes: ['https://www.googleapis.com/auth/youtube.upload'],
  });
  rotator.register({
    tenantId: 'creator-bom',
    platform: 'instagram-reels',
    refreshToken: 'demo-refresh-3',
    expiresAtMs: now() - 1_000,
  });

  for (let index = 0; index < 18; index += 1) tenants.consume('agency-morning', 'meta');
  for (let index = 0; index < 4; index += 1) tenants.consume('agency-morning', 'youtube');
  for (let index = 0; index < 3; index += 1) tenants.consume('creator-bom', 'meta');

  const topics = [
    '부산 신혼집 3평 주방 수납',
    '퇴사 후 실업급여 신청 순서',
    '겨울 퍼스널컬러 코트 고르기',
  ];
  for (let index = 0; index < 11; index += 1) {
    const tenant = TENANTS[index % TENANTS.length];
    await queue.enqueue({
      tenantId: tenant.id,
      name: `render-episode-${String(index + 1).padStart(2, '0')}`,
      priority: index % 5 === 0 ? 9 : index % 3 === 0 ? 7 : 5,
      maxAttempts: 3,
      payload: {
        projectId: `episode-${String(index + 1).padStart(2, '0')}`,
        title: topics[index % topics.length],
        platform: index % 4 === 0 ? 'youtube-shorts' : 'instagram-reels',
        durationSec: 30 + (index % 4) * 10,
        chunkCount: 4,
      },
    });
  }

  const pool = new WorkerPool({
    queue,
    size: 3,
    sleep,
    now,
    handler: createSimulatedRenderHandler({
      chunkMs: 15,
      sleep: async (ms) => sleep(ms),
      failOn: (job, attempt) => {
        if (job.name === 'render-episode-07') return 'encoder OOM (worker restarted)';
        if (job.name === 'render-episode-03' && attempt === 1) return 'source segment not ready';
        return null;
      },
    }),
  });
  await pool.drain({ waitForDelayed: true });

  // A scheduled slot still waiting for tomorrow morning: it must stay delayed
  // through the drain, which is what makes the console show a real backlog.
  await queue.enqueue({
    tenantId: TENANTS[1].id,
    name: 'render-episode-12',
    priority: 5,
    payload: { projectId: 'episode-12', platform: 'instagram-reels', durationSec: 50, chunkCount: 4 },
    delayMs: 30 * 60 * 1_000,
  });

  const bad = await queue.enqueue({
    tenantId: 'creator-bom',
    name: 'render-episode-13-broken-source',
    payload: { projectId: 'episode-13', platform: 'instagram-reels', durationSec: 42, chunkCount: 4 },
  });
  await queue.reserve('worker-1');
  await queue.fail(bad.id, new Error('unsupported pixel format: yuv444p'), { retryable: false });

  const ingestor = new TelemetryIngestor({ now });
  const experiments: Experiment[] = [
    {
      id: 'exp-kitchen-hook',
      topic: '부산 신혼집 3평 주방 수납',
      variants: generateHookVariants('부산 신혼집 3평 주방 수납', { count: 3 }),
      startedAt: new Date(now() - 36 * 60 * 60 * 1_000).toISOString(),
      status: 'concluded',
    },
    {
      id: 'exp-commute-hook',
      topic: '출근길 10분 아침 루틴',
      variants: generateHookVariants('출근길 10분 아침 루틴', { count: 3 }),
      startedAt: new Date(now() - 12 * 60 * 60 * 1_000).toISOString(),
      status: 'running',
    },
  ];

  const kitchen = experiments[0];
  const commute = experiments[1];
  const kitchenRows: Array<[string, number, number, number]> = [
    ['A', 24_800, 17_400, 8_300],
    ['B', 24_100, 18_900, 12_400],
    ['C', 23_600, 16_800, 8_900],
  ];
  const commuteRows: Array<[string, number, number, number]> = [
    ['A', 9_200, 6_300, 2_600],
    ['B', 9_000, 6_100, 2_520],
    ['C', 8_800, 6_000, 2_480],
  ];
  const seedRows = (
    experiment: Experiment,
    rows: Array<[string, number, number, number]>,
  ): void => {
    for (const [variantId, impressions, views3s, completions] of rows) {
      const windows: MetricWindow[] = ['24h', '7d'];
      for (const window of windows) {
        ingestor.ingest({
          eventId: `${experiment.id}:${variantId}:${window}`,
          experimentId: experiment.id,
          variantId,
          platform: 'instagram-reels',
          window,
          capturedAt: new Date(now()).toISOString(),
          impressions: window === '7d' ? impressions * 2 : impressions,
          views3s: window === '7d' ? views3s * 2 : views3s,
          watchTimeSec: (window === '7d' ? views3s * 2 : views3s) * 6.4,
          completions: window === '7d' ? Math.round(completions * 1.7) : completions,
          likes: Math.round(impressions * 0.04),
          comments: Math.round(impressions * 0.006),
          shares: Math.round(impressions * 0.002),
          saves: Math.round(impressions * 0.009),
          source: 'meta-webhook',
        });
      }
    }
  };
  seedRows(kitchen, kitchenRows);
  seedRows(commute, commuteRows);

  const console = new StudioConsole({
    queue,
    tenants,
    workers: pool,
    credentials: rotator,
    telemetry: ingestor,
    // The demo console is operable: its DLQ buttons work against the in-memory queue,
    // which is the point of the demo ("this is what an operator does at 2am").
    dlq: new DlqActionService({ queue, now }),
    now,
  });
  for (const experiment of experiments) {
    console.registerExperiment({ experiment, metric: 'retention', window: '24h', minSample: 1_000 });
  }

  return { queue, tenants, rotator, ingestor, console, experiments };
}

/** Convenience for tests that want the winning variant's angle. */
export function variantById(variants: HookVariant[], id: string): HookVariant | undefined {
  return variants.find((variant) => variant.id === id);
}
