import type { CredentialSnapshot, OAuthTokenRotator } from '../../lib/rateLimit/oauth';
import type { TenantLimitView, TenantRegistry } from '../../lib/rateLimit/tenantRegistry';
import type { JobQueue } from '../../lib/queue/jobQueue';
import type { WorkerPool } from '../../lib/queue/workerPool';
import type { TelemetryIngestor } from '../../lib/telemetry/metrics';
import { evaluateExperiment } from '../../lib/telemetry/significance';
import type {
  Experiment,
  ExperimentEvaluation,
  HookAngle,
  MetricWindow,
  ProportionMetric,
} from '../../types/telemetry';
import type { JobKind } from '../../types/queue';

export interface StudioExperimentConfig {
  experiment: Experiment;
  metric?: ProportionMetric;
  window?: MetricWindow;
  minSample?: number;
}

export interface StudioQueueView {
  counts: Record<string, number>;
  total: number;
  successRate: number;
  meanLatencyMs: number;
  p95LatencyMs: number;
  retries: number;
  oldestWaitingAgeMs: number;
}

export interface StudioWorkerView {
  workerId: string;
  state: string;
  utilization: number;
  jobsProcessed: number;
  jobsFailed: number;
}

export interface StudioExperimentView {
  experimentId: string;
  topic: string;
  metric: ProportionMetric;
  window: MetricWindow;
  status: ExperimentEvaluation['status'];
  winner: string | null;
  confidence: number;
  requiredSample: number;
  variants: Array<{
    variantId: string;
    angle: HookAngle | null;
    text: string;
    value: number;
    trials: number;
    lift: number;
    pValue: number;
  }>;
  notes: string[];
}

export interface StudioDlqEntry {
  jobId: string;
  tenantId: string;
  name: string;
  kind: JobKind;
  attempts: number;
  lastError: string | null;
  failedAt: string | null;
}

export interface StudioSnapshot {
  generatedAt: string;
  health: { status: 'ok' | 'degraded' | 'critical'; reasons: string[] };
  queue: StudioQueueView;
  workers: StudioWorkerView[];
  tenants: TenantLimitView[];
  credentials: CredentialSnapshot[];
  experiments: StudioExperimentView[];
  dlq: StudioDlqEntry[];
}

export interface StudioConsoleOptions {
  queue: JobQueue;
  tenants: TenantRegistry;
  workers?: WorkerPool;
  credentials?: OAuthTokenRotator;
  telemetry?: TelemetryIngestor;
  now?: () => number;
}

const BAR_WIDTH = 18;

function bar(ratio: number, width = BAR_WIDTH): string {
  const filled = Math.round(Math.min(1, Math.max(0, ratio)) * width);
  return `${'█'.repeat(filled)}${'░'.repeat(width - filled)}`;
}

function pct(ratio: number): string {
  return `${Math.round(ratio * 100)}%`.padStart(4);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Read model over the whole platform: queue, workers, tenant quotas, OAuth
 * health, experiments. It reads live objects but stores nothing, so the same
 * snapshot feeds the terminal, the HTML page and the Prometheus endpoint —
 * three consumers of one truth instead of three ad-hoc queries.
 */
export class StudioConsole {
  private readonly queue: JobQueue;
  private readonly tenants: TenantRegistry;
  private readonly workers?: WorkerPool;
  private readonly credentials?: OAuthTokenRotator;
  private readonly telemetry?: TelemetryIngestor;
  private readonly now: () => number;
  private readonly experiments = new Map<string, StudioExperimentConfig>();

  constructor(options: StudioConsoleOptions) {
    this.queue = options.queue;
    this.tenants = options.tenants;
    this.workers = options.workers;
    this.credentials = options.credentials;
    this.telemetry = options.telemetry;
    this.now = options.now ?? Date.now;
  }

  registerExperiment(config: StudioExperimentConfig): void {
    this.experiments.set(config.experiment.id, config);
  }

  async snapshot(): Promise<StudioSnapshot> {
    const stats = await this.queue.stats();
    const dlqJobs = await this.queue.list('dlq');
    const experiments = [...this.experiments.values()].map((config) => {
      const aggregates = this.telemetry?.aggregate(config.experiment.id, config.window ?? '24h') ?? [];
      return this.renderExperiment(config, aggregates);
    });
    const credentials = this.credentials?.snapshot() ?? [];
    const tenants = this.tenants.snapshot();

    const reasons: string[] = [];
    if (stats.counts.dlq > 0) reasons.push(`${stats.counts.dlq} job(s) in DLQ`);
    if (stats.counts.failed > 0) reasons.push(`${stats.counts.failed} non-retryable failure(s)`);
    if (stats.total > 0 && stats.successRate < 0.9) {
      reasons.push(`success rate ${(stats.successRate * 100).toFixed(1)}%`);
    }
    for (const tenant of tenants) {
      for (const provider of tenant.providers) {
        if (provider.quotaRemaining <= 0) {
          reasons.push(`${tenant.tenantId} ${provider.provider} daily quota exhausted`);
        }
      }
    }
    for (const credential of credentials) {
      if (credential.status === 'needs-reauth') {
        reasons.push(`${credential.tenantId} ${credential.platform} needs re-auth`);
      }
    }
    // One poisoned job is a Tuesday; a growing DLQ or a revoked credential is
    // an incident. Tiering the two keeps the console from crying wolf.
    const critical =
      stats.counts.dlq >= 3 ||
      reasons.some((reason) => reason.includes('needs re-auth')) ||
      (stats.total > 0 && stats.successRate < 0.7 && stats.counts.completed + stats.counts.dlq + stats.counts.failed >= 5);
    const health: StudioSnapshot['health'] = {
      status: critical ? 'critical' : reasons.length > 0 ? 'degraded' : 'ok',
      reasons,
    };

    return {
      generatedAt: new Date(this.now()).toISOString(),
      health,
      queue: {
        counts: stats.counts,
        total: stats.total,
        successRate: stats.successRate,
        meanLatencyMs: stats.meanLatencyMs,
        p95LatencyMs: stats.p95LatencyMs,
        retries: stats.retries,
        oldestWaitingAgeMs: stats.oldestWaitingAgeMs,
      },
      workers:
        this.workers?.loads.map((load) => ({
          workerId: load.workerId,
          state: load.state,
          utilization: load.utilization,
          jobsProcessed: load.jobsProcessed,
          jobsFailed: load.jobsFailed,
        })) ?? [],
      tenants,
      credentials,
      experiments,
      dlq: dlqJobs.map((job) => ({
        jobId: job.id,
        tenantId: job.tenantId,
        name: job.name,
        kind: job.kind,
        attempts: job.attempts,
        lastError: job.lastError,
        failedAt: job.finishedAt,
      })),
    };
  }

  private renderExperiment(
    config: StudioExperimentConfig,
    aggregates: ReturnType<TelemetryIngestor['aggregate']>,
  ): StudioExperimentView {
    const evaluation = evaluateExperiment(config.experiment.id, aggregates, {
      metric: config.metric ?? 'retention',
      window: config.window ?? '24h',
      minSample: config.minSample ?? 200,
    });
    const angleOf = new Map(config.experiment.variants.map((variant) => [variant.id, variant]));
    return {
      experimentId: config.experiment.id,
      topic: config.experiment.topic,
      metric: evaluation.metric,
      window: evaluation.window,
      status: evaluation.status,
      winner: evaluation.winner,
      confidence: evaluation.confidence,
      requiredSample: evaluation.requiredSample,
      variants: evaluation.variants.map((score) => ({
        variantId: score.variantId,
        angle: angleOf.get(score.variantId)?.angle ?? null,
        text: angleOf.get(score.variantId)?.text ?? '',
        value: score.value,
        trials: score.trials,
        lift: score.lift,
        pValue: score.pValue,
      })),
      notes: evaluation.notes,
    };
  }

  /** Terminal view. Fixed-width so it stays readable in a log viewer. */
  renderText(snapshot: StudioSnapshot): string {
    const lines: string[] = [];
    const rule = '─'.repeat(66);
    lines.push(`STUDIO CONSOLE  ${snapshot.generatedAt}  [${snapshot.health.status.toUpperCase()}]`);
    lines.push(rule);
    lines.push(
      `QUEUE  total ${snapshot.queue.total}  ok ${pct(snapshot.queue.successRate)}  p95 ${snapshot.queue.p95LatencyMs}ms  retries ${snapshot.queue.retries}`,
    );
    const counts = snapshot.queue.counts;
    lines.push(
      `       waiting ${String(counts.waiting).padStart(3)}  active ${String(counts.active).padStart(3)}  delayed ${String(counts.delayed).padStart(3)}  done ${String(counts.completed).padStart(3)}  failed ${String(counts.failed).padStart(3)}  dlq ${String(counts.dlq).padStart(3)}`,
    );
    if (snapshot.workers.length > 0) {
      lines.push(rule);
      lines.push('WORKERS');
      for (const worker of snapshot.workers) {
        lines.push(
          `  ${worker.workerId.padEnd(10)} ${bar(worker.utilization)} ${pct(worker.utilization)}  ${worker.state.padEnd(7)} ok ${worker.jobsProcessed} fail ${worker.jobsFailed}`,
        );
      }
    }
    lines.push(rule);
    lines.push('TENANT RATE LIMITS');
    for (const tenant of snapshot.tenants) {
      lines.push(`  ${tenant.name} (${tenant.plan})`);
      for (const provider of tenant.providers) {
        const requestRatio = provider.requestCapacity === 0 ? 0 : provider.requestRemaining / provider.requestCapacity;
        const quotaRatio = provider.quotaLimit === 0 ? 0 : provider.quotaRemaining / provider.quotaLimit;
        lines.push(
          `    ${provider.provider.padEnd(8)} req ${bar(requestRatio, 10)} ${String(provider.requestRemaining).padStart(3)}/${provider.requestCapacity}` +
            `  quota ${bar(quotaRatio, 10)} ${provider.quotaRemaining}/${provider.quotaLimit}` +
            `${provider.blockedForMs > 0 ? `  BLOCKED ${Math.ceil(provider.blockedForMs / 1_000)}s` : ''}`,
        );
      }
    }
    if (snapshot.credentials.length > 0) {
      lines.push(rule);
      lines.push('OAUTH');
      for (const credential of snapshot.credentials) {
        const remainingMin = Math.round(credential.expiresInMs / 60_000);
        lines.push(
          `  ${credential.tenantId} ${credential.platform.padEnd(16)} ${credential.status.padEnd(12)} exp ${String(remainingMin).padStart(4)}m  refreshes ${credential.refreshCount}`,
        );
      }
    }
    if (snapshot.experiments.length > 0) {
      lines.push(rule);
      lines.push('HOOK A/B');
      for (const experiment of snapshot.experiments) {
        lines.push(`  ${experiment.experimentId}  ${experiment.metric}/${experiment.window}  ${experiment.status}`);
        for (const variant of experiment.variants) {
          lines.push(
            `    ${variant.variantId} ${(variant.angle ?? '-').padEnd(10)} ${(variant.value * 100).toFixed(1).padStart(5)}%  n=${String(variant.trials).padStart(5)}  lift ${(variant.lift * 100).toFixed(1).padStart(6)}%  p ${variant.pValue.toFixed(3)}`,
          );
        }
        lines.push(`    winner: ${experiment.winner ?? '—'}  confidence ${(experiment.confidence * 100).toFixed(1)}%`);
      }
    }
    if (snapshot.dlq.length > 0) {
      lines.push(rule);
      lines.push('DEAD LETTER QUEUE');
      for (const entry of snapshot.dlq) {
        lines.push(`  ${entry.jobId.slice(0, 18)}  ${entry.tenantId}  attempts ${entry.attempts}  ${entry.lastError ?? ''}`);
      }
    }
    if (snapshot.health.reasons.length > 0) {
      lines.push(rule);
      lines.push(`HEALTH: ${snapshot.health.reasons.join(' · ')}`);
    }
    return `${lines.join('\n')}\n`;
  }

  /** One self-contained page — no CDN, no JS, safe to open from disk. */
  renderHtml(snapshot: StudioSnapshot): string {
    const tenantRows = snapshot.tenants
      .flatMap((tenant) =>
        tenant.providers.map(
          (provider) => `<tr>
      <td>${escapeHtml(tenant.name)}</td>
      <td class="muted">${tenant.plan}</td>
      <td>${provider.provider}</td>
      <td><div class="meter"><span style="width:${Math.round((1 - provider.requestRemaining / Math.max(1, provider.requestCapacity)) * 100)}%"></span></div></td>
      <td class="num">${provider.requestRemaining}/${provider.requestCapacity}</td>
      <td><div class="meter quota"><span style="width:${Math.round((1 - provider.quotaRemaining / Math.max(1, provider.quotaLimit)) * 100)}%"></span></div></td>
      <td class="num">${provider.quotaRemaining}/${provider.quotaLimit}</td>
    </tr>`,
        ),
      )
      .join('\n');

    const experimentCards = snapshot.experiments
      .map(
        (experiment) => `<section class="card">
      <h3>${escapeHtml(experiment.experimentId)} <span class="tag ${experiment.status}">${experiment.status}</span></h3>
      <p class="muted">${escapeHtml(experiment.topic)} · ${experiment.metric} / ${experiment.window} · winner ${experiment.winner ?? '—'} (${(experiment.confidence * 100).toFixed(1)}%)</p>
      <table>
        <tr><th>variant</th><th>angle</th><th>hook</th><th>value</th><th>n</th><th>lift</th><th>p</th></tr>
        ${experiment.variants
          .map(
            (variant) => `<tr><td>${variant.variantId}</td><td>${variant.angle ?? '-'}</td><td>${escapeHtml(variant.text)}</td><td class="num">${(variant.value * 100).toFixed(1)}%</td><td class="num">${variant.trials}</td><td class="num">${(variant.lift * 100).toFixed(1)}%</td><td class="num">${variant.pValue.toFixed(3)}</td></tr>`,
          )
          .join('')}
      </table>
    </section>`,
      )
      .join('\n');

    const workerRows = snapshot.workers
      .map(
        (worker) => `<tr><td>${escapeHtml(worker.workerId)}</td><td>${worker.state}</td>
      <td><div class="meter"><span style="width:${Math.round(worker.utilization * 100)}%"></span></div></td>
      <td class="num">${Math.round(worker.utilization * 100)}%</td><td class="num">${worker.jobsProcessed}</td><td class="num">${worker.jobsFailed}</td></tr>`,
      )
      .join('\n');

    const dlqRows =
      snapshot.dlq.length === 0
        ? '<tr><td colspan="4" class="muted">empty</td></tr>'
        : snapshot.dlq
            .map(
              (entry) =>
                `<tr><td><code>${escapeHtml(entry.jobId)}</code></td><td>${escapeHtml(entry.tenantId)}</td><td class="num">${entry.attempts}</td><td>${escapeHtml(entry.lastError ?? '')}</td></tr>`,
            )
            .join('\n');

    return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>shortform studio — ${snapshot.health.status}</title>
<style>
  :root { color-scheme: dark; --bg:#0d1117; --panel:#161b22; --line:#30363d; --text:#e6edf3; --muted:#8b949e; --green:#3fb950; --amber:#d29922; --red:#f85149; }
  * { box-sizing: border-box; }
  body { margin:0; padding:32px; background:var(--bg); color:var(--text); font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
  h1 { font-size:20px; margin:0 0 4px; } h2 { font-size:15px; margin:28px 0 10px; text-transform:uppercase; letter-spacing:.08em; color:var(--muted); }
  h3 { font-size:14px; margin:0 0 6px; }
  .sub { color:var(--muted); margin-bottom:20px; }
  .pill { display:inline-block; padding:2px 8px; border-radius:999px; font-size:12px; font-weight:600; }
  .pill.ok { background:rgba(63,185,80,.15); color:var(--green); } .pill.degraded { background:rgba(210,153,34,.15); color:var(--amber); } .pill.critical { background:rgba(248,81,73,.15); color:var(--red); }
  .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:12px; }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:16px; margin-bottom:12px; }
  .stat { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:14px 16px; }
  .stat b { display:block; font-size:24px; font-variant-numeric:tabular-nums; } .stat span { color:var(--muted); font-size:12px; }
  table { width:100%; border-collapse:collapse; background:var(--panel); border:1px solid var(--line); border-radius:10px; overflow:hidden; }
  th, td { text-align:left; padding:8px 12px; border-bottom:1px solid var(--line); font-size:13px; }
  th { color:var(--muted); font-weight:500; font-size:12px; text-transform:uppercase; letter-spacing:.04em; }
  tr:last-child td { border-bottom:0; }
  .num { font-variant-numeric:tabular-nums; text-align:right; }
  .muted { color:var(--muted); }
  code { font-size:12px; }
  .meter { width:120px; height:6px; background:#21262d; border-radius:999px; overflow:hidden; }
  .meter span { display:block; height:100%; background:var(--green); }
  .meter.quota span { background:var(--amber); }
  .tag { font-size:11px; padding:1px 7px; border-radius:999px; background:#21262d; color:var(--muted); text-transform:uppercase; }
  .tag.winner { background:rgba(63,185,80,.15); color:var(--green); }
  .tag.inconclusive { background:rgba(210,153,34,.15); color:var(--amber); }
</style></head><body>
<h1>shortform studio</h1>
<div class="sub">${snapshot.generatedAt} · <span class="pill ${snapshot.health.status}">${snapshot.health.status}</span>
${snapshot.health.reasons.map((reason) => ` · ${escapeHtml(reason)}`).join('')}</div>
<div class="grid">
  <div class="stat"><b>${snapshot.queue.counts.waiting}</b><span>waiting</span></div>
  <div class="stat"><b>${snapshot.queue.counts.active}</b><span>active</span></div>
  <div class="stat"><b>${snapshot.queue.counts.delayed}</b><span>delayed</span></div>
  <div class="stat"><b>${snapshot.queue.counts.completed}</b><span>completed</span></div>
  <div class="stat"><b>${snapshot.queue.counts.dlq}</b><span>in DLQ</span></div>
  <div class="stat"><b>${(snapshot.queue.successRate * 100).toFixed(1)}%</b><span>success</span></div>
  <div class="stat"><b>${snapshot.queue.p95LatencyMs}ms</b><span>p95 latency</span></div>
</div>
<h2>Workers</h2>
<table><tr><th>worker</th><th>state</th><th>load</th><th></th><th>done</th><th>failed</th></tr>${workerRows}</table>
<h2>Tenant rate limits</h2>
<table><tr><th>tenant</th><th>plan</th><th>provider</th><th>requests used</th><th></th><th>daily quota used</th><th></th></tr>${tenantRows}</table>
${experimentCards ? `<h2>Hook A/B</h2>${experimentCards}` : ''}
<h2>Dead letter queue</h2>
<table><tr><th>job</th><th>tenant</th><th>attempts</th><th>last error</th></tr>${dlqRows}</table>
</body></html>
`;
  }

  /** Prometheus text exposition — the same numbers, scraped. */
  toPrometheus(snapshot: StudioSnapshot): string {
    const lines: string[] = [];
    lines.push('# HELP shortform_queue_jobs Jobs by state');
    lines.push('# TYPE shortform_queue_jobs gauge');
    for (const [state, value] of Object.entries(snapshot.queue.counts)) {
      lines.push(`shortform_queue_jobs{state="${state}"} ${value}`);
    }
    lines.push('# HELP shortform_queue_success_rate Completed / terminal jobs');
    lines.push('# TYPE shortform_queue_success_rate gauge');
    lines.push(`shortform_queue_success_rate ${snapshot.queue.successRate}`);
    lines.push('# TYPE shortform_queue_latency_p95_ms gauge');
    lines.push(`shortform_queue_latency_p95_ms ${snapshot.queue.p95LatencyMs}`);
    lines.push('# TYPE shortform_worker_utilization gauge');
    for (const worker of snapshot.workers) {
      lines.push(`shortform_worker_utilization{worker="${worker.workerId}"} ${worker.utilization}`);
    }
    lines.push('# TYPE shortform_tenant_quota_remaining gauge');
    for (const tenant of snapshot.tenants) {
      for (const provider of tenant.providers) {
        lines.push(
          `shortform_tenant_quota_remaining{tenant="${tenant.tenantId}",provider="${provider.provider}"} ${provider.quotaRemaining}`,
        );
        lines.push(
          `shortform_tenant_rate_blocked_ms{tenant="${tenant.tenantId}",provider="${provider.provider}"} ${provider.blockedForMs}`,
        );
      }
    }
    lines.push('# TYPE shortform_oauth_needs_reauth gauge');
    for (const credential of snapshot.credentials) {
      lines.push(
        `shortform_oauth_needs_reauth{tenant="${credential.tenantId}",platform="${credential.platform}"} ${credential.status === 'needs-reauth' ? 1 : 0}`,
      );
    }
    lines.push('# TYPE shortform_experiment_confidence gauge');
    for (const experiment of snapshot.experiments) {
      lines.push(
        `shortform_experiment_confidence{experiment="${experiment.experimentId}",status="${experiment.status}"} ${experiment.confidence}`,
      );
    }
    return `${lines.join('\n')}\n`;
  }
}
