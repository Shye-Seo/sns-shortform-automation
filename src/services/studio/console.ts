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
import { DlqActionService, type DlqActionOutcome, type DlqActionRecord } from './dlqActions';

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
  /** Retry budget, so "attempts 3/3" explains why it is in the DLQ at all. */
  maxAttempts: number;
  priority: number;
  progress: number;
  lastError: string | null;
  failedAt: string | null;
  /** How long it has been sitting in the DLQ (ms) — the operator's triage signal. */
  failedAgoMs: number | null;
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
  /** Recent retry/discard operations — who did what, and what was refused. */
  dlqActions: DlqActionRecord[];
}

export interface StudioConsoleOptions {
  queue: JobQueue;
  tenants: TenantRegistry;
  workers?: WorkerPool;
  credentials?: OAuthTokenRotator;
  telemetry?: TelemetryIngestor;
  /** Absent → the console is read-only and the buttons explain why. */
  dlq?: DlqActionService;
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

/** 3m 12s / 2h 04m — DLQ age in the unit an operator thinks in. */
export function formatAge(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`;
  return `${Math.floor(hours / 24)}d ${String(hours % 24).padStart(2, '0')}h`;
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
  private readonly dlq?: DlqActionService;
  private readonly now: () => number;
  private readonly experiments = new Map<string, StudioExperimentConfig>();

  constructor(options: StudioConsoleOptions) {
    this.queue = options.queue;
    this.tenants = options.tenants;
    this.workers = options.workers;
    this.credentials = options.credentials;
    this.telemetry = options.telemetry;
    this.dlq = options.dlq;
    this.now = options.now ?? Date.now;
  }

  /** Whether one-click DLQ actions are wired (a read-only console says so instead of lying). */
  get canOperateDlq(): boolean {
    return this.dlq !== undefined;
  }

  /**
   * One-click retry from the monitoring console.
   * The console owns the *decision*; the service owns the *rule* and the audit record.
   */
  async retryDlqJob(jobId: string, actor = 'studio-console'): Promise<DlqActionOutcome> {
    return this.operateDlq('retry', jobId, actor);
  }

  async discardDlqJob(jobId: string, actor = 'studio-console'): Promise<DlqActionOutcome> {
    return this.operateDlq('discard', jobId, actor);
  }

  private async operateDlq(action: 'retry' | 'discard', jobId: string, actor: string): Promise<DlqActionOutcome> {
    const at = new Date(this.now()).toISOString();
    if (!this.dlq) {
      return {
        status: 409,
        ok: false,
        action,
        jobId,
        message: 'DLQ 조작이 연결되지 않았습니다. StudioConsole에 dlq(DlqActionService)를 주입하세요.',
        at,
      };
    }
    return action === 'retry' ? this.dlq.retry(jobId, actor) : this.dlq.discard(jobId, actor);
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
        maxAttempts: job.maxAttempts,
        priority: job.priority,
        progress: job.progress,
        lastError: job.lastError,
        failedAt: job.finishedAt,
        failedAgoMs: job.finishedAt ? Math.max(0, this.now() - Date.parse(job.finishedAt)) : null,
      })),
      dlqActions: this.dlq?.recent(8) ?? [],
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
      lines.push(`DEAD LETTER QUEUE  ${snapshot.dlq.length} job(s) need a decision`);
      for (const entry of snapshot.dlq) {
        const age = entry.failedAgoMs === null ? '—' : formatAge(entry.failedAgoMs);
        lines.push(
          `  ${entry.jobId.slice(0, 18)}  ${entry.tenantId}  ${entry.kind.padEnd(8)} attempts ${entry.attempts}/${entry.maxAttempts}  waiting ${age}`,
        );
        lines.push(`    ${entry.name}  ·  ${entry.lastError ?? 'no error message'}`);
      }
      lines.push(
        this.canOperateDlq
          ? '  재시도/폐기: npm run cli -- queue replay <jobId> · studio --serve 로 열면 원클릭 버튼이 동작합니다'
          : '  재시도/폐기: npm run cli -- queue replay <jobId> (콘솔 조작은 DlqActionService 주입 시 활성화)',
      );
    }
    if (snapshot.dlqActions.length > 0) {
      lines.push(rule);
      lines.push('DLQ OPERATOR LOG');
      for (const record of snapshot.dlqActions) {
        lines.push(
          `  ${record.at.slice(11, 19)}  ${record.action.padEnd(7)} ${record.jobId.slice(0, 18).padEnd(18)} ${record.outcome.padEnd(7)} ${record.actor}  ${record.detail}`,
        );
      }
    }
    if (snapshot.health.reasons.length > 0) {
      lines.push(rule);
      lines.push(`HEALTH: ${snapshot.health.reasons.join(' · ')}`);
    }
    return `${lines.join('\n')}\n`;
  }

  /**
   * One self-contained page — no CDN, no external assets.
   *
   * `actionBasePath` decides whether the DLQ buttons are live: when the page is
   * served by the studio server (`cli studio --serve`) the forms post to
   * `/v1/queue/dlq/{id}/{retry|discard}`. Opened from disk they are rendered
   * disabled with the reason, instead of looking clickable and doing nothing.
   */
  renderHtml(snapshot: StudioSnapshot, options: { actionBasePath?: string; standalone?: boolean } = {}): string {
    const actionBase = (options.actionBasePath ?? '/v1').replace(/\/+$/, '');
    // 파일로 내보낸 페이지(file://)에는 POST할 서버가 없다. 눌러도 아무 일이 없는 버튼을
    // 그리느니, 사유를 적고 비활성으로 그린다.
    const actionsLive = this.canOperateDlq && options.standalone !== true;
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
        ? '<tr><td colspan="7" class="muted">empty — 실패한 작업이 없습니다</td></tr>'
        : snapshot.dlq
            .map((entry) => {
              const jobId = escapeHtml(entry.jobId);
              const age = entry.failedAgoMs === null ? '—' : formatAge(entry.failedAgoMs);
              const buttons = actionsLive
                ? `<form class="inline" method="post" data-dlq="retry" action="${escapeHtml(`${actionBase}/queue/dlq/${encodeURIComponent(entry.jobId)}/retry`)}">
          <button type="submit" class="btn retry"${entry.attempts >= entry.maxAttempts ? '' : ''}>재시도</button></form>
        <form class="inline" method="post" data-dlq="discard" action="${escapeHtml(`${actionBase}/queue/dlq/${encodeURIComponent(entry.jobId)}/discard`)}">
          <button type="submit" class="btn discard">폐기</button></form>`
                : `<span class="muted" title="콘솔 서버로 열어야 동작합니다">버튼 비활성</span>`;
              return `<tr>
        <td><code>${jobId}</code><div class="muted small">${escapeHtml(entry.name)}</div></td>
        <td>${escapeHtml(entry.tenantId)}</td>
        <td>${entry.kind}${entry.priority >= 8 ? ' <span class="tag">P' + entry.priority + '</span>' : ''}</td>
        <td class="num">${entry.attempts}/${entry.maxAttempts}</td>
        <td class="num">${age}</td>
        <td class="err">${escapeHtml(entry.lastError ?? '')}</td>
        <td class="act">${buttons}</td>
      </tr>`;
            })
            .join('\n');

    const dlqActionRows = snapshot.dlqActions
      .map(
        (record) =>
          `<tr><td class="muted">${escapeHtml(record.at.slice(11, 19))}</td><td>${record.action}</td><td><code>${escapeHtml(record.jobId)}</code></td><td><span class="tag ${record.outcome === 'applied' ? 'applied' : 'rejected'}">${record.outcome}</span></td><td>${escapeHtml(record.actor)}</td><td class="muted">${escapeHtml(record.detail)}</td></tr>`,
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
  .tag.applied { background:rgba(63,185,80,.15); color:var(--green); }
  .tag.rejected { background:rgba(248,81,73,.15); color:var(--red); }
  .count { font-size:12px; color:var(--muted); font-weight:400; }
  .sub2 { color:var(--muted); font-size:12px; margin:0 0 8px; }
  .small { font-size:11px; }
  .err { max-width:280px; color:#ffb4a8; font-size:12px; }
  .act { white-space:nowrap; }
  form.inline { display:inline; }
  .btn { font:inherit; font-size:12px; padding:4px 10px; border-radius:6px; cursor:pointer;
         border:1px solid var(--line); background:#21262d; color:var(--text); margin-right:4px; }
  .btn:hover { border-color:#8b949e; }
  .btn.retry { border-color:rgba(63,185,80,.5); color:var(--green); }
  .btn.retry:hover { background:rgba(63,185,80,.15); }
  .btn.discard { border-color:rgba(248,81,73,.4); color:var(--red); }
  .btn.discard:hover { background:rgba(248,81,73,.12); }
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
<h2>Dead letter queue <span class="count">${snapshot.dlq.length}</span></h2>
<p class="sub2">실패한 렌더링 작업을 사람이 결정할 때까지 보관합니다. 재시도는 시도 횟수를 초기화해 대기열로 되돌리고, 폐기는 행을 지우되 이벤트 로그에 사유를 남깁니다.</p>
<table><tr><th>job</th><th>tenant</th><th>kind</th><th>attempts</th><th>waiting</th><th>last error</th><th>action</th></tr>${dlqRows}</table>
${
  actionsLive
    ? '<p class="sub2">버튼은 이 API 서버의 <code>/v1/queue/dlq/{jobId}/retry|discard</code> 로 POST합니다. 폐기는 확인창을 한 번 거칩니다.</p>'
    : '<p class="sub2">이 페이지는 파일로 내보내져 조작 API가 없습니다. <code>npm run cli -- studio --serve</code> 로 열면 원클릭 재시도/폐기가 활성화됩니다.</p>'
}
${
  snapshot.dlqActions.length > 0
    ? `<h2>Operator log</h2>
<table><tr><th>time</th><th>action</th><th>job</th><th>result</th><th>actor</th><th>detail</th></tr>${dlqActionRows}</table>`
    : ''
}
<script>
  // 점진적 향상: JS가 없으면 form POST로 그대로 동작한다(응답은 JSON으로 보인다).
  document.querySelectorAll('form[data-dlq]').forEach(function (form) {
    form.addEventListener('submit', function (event) {
      if (form.getAttribute('data-dlq') === 'discard' && !window.confirm('이 작업을 DLQ에서 폐기할까요? 되돌릴 수 없습니다.')) {
        event.preventDefault();
        return;
      }
      event.preventDefault();
      fetch(form.action, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ actor: 'studio-console' }),
      })
        .then(function (response) { return response.json().catch(function () { return {}; }); })
        .then(function (data) {
          if (data && data.ok) { window.location.reload(); }
          else { window.alert((data && data.message) || '요청이 거부되었습니다.'); }
        })
        .catch(function (error) { window.alert('요청 실패: ' + error); });
    });
  });
</script>
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
