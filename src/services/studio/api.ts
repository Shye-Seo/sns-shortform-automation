import type { StudioConsole, StudioSnapshot } from './console';

export interface StudioApiRequest {
  method: string;
  path: string;
  /** Parsed JSON body for POST routes (the HTTP adapter does the parsing). */
  body?: unknown;
  /** Who is acting. Comes from the `x-operator` header or the body; defaults to 'operator'. */
  actor?: string;
}

export interface StudioApiResponse {
  status: number;
  contentType: string;
  headers?: Record<string, string>;
  body: unknown;
}

/**
 * HTTP surface over `StudioConsole`.
 *
 * Read routes are GET-only. The only mutations are the two DLQ decisions, and
 * they are deliberately narrow:
 *
 *   POST /v1/queue/dlq/{jobId}/retry     requeue a failed job (attempts reset)
 *   POST /v1/queue/dlq/{jobId}/discard   give up on it (row removed, event kept)
 *
 * Why POST and not GET: a link that retries a failed encode is a link that will
 * be fired by a mail scanner, a preview bot, or an accidental click. Mutating a
 * queue requires an explicit POST with the job id in the path, and the rule for
 * *which* jobs may change lives in `DlqActionService`, not here.
 *
 * `GET /` renders the same console HTML the CLI writes to disk, but with the
 * action buttons wired to this server.
 */
export class StudioApi {
  constructor(private readonly console: StudioConsole) {}

  async handle(request: StudioApiRequest): Promise<StudioApiResponse> {
    const method = request.method.toUpperCase();
    const path = normalizePath(request.path);
    const parts = path.split('/').filter(Boolean);

    if (method === 'POST') {
      return this.handlePost(request, parts);
    }

    if (method !== 'GET') {
      return {
        status: 405,
        contentType: 'application/json',
        headers: { allow: 'GET, POST' },
        body: { error: 'method_not_allowed', method },
      };
    }

    const snapshot = await this.console.snapshot();

    // Served console: same HTML as `studio --html`, but the DLQ buttons can reach the API.
    if (path === '/' || path === '/console') {
      return {
        status: 200,
        contentType: 'text/html; charset=utf-8',
        headers: { 'cache-control': 'no-store' },
        body: this.console.renderHtml(snapshot, { actionBasePath: '/v1' }),
      };
    }

    if (path === '/v1/health') {
      return json(200, { status: snapshot.health.status, reasons: snapshot.health.reasons, generatedAt: snapshot.generatedAt });
    }
    if (path === '/v1/snapshot') return json(200, snapshot);
    if (path === '/v1/queue') return json(200, snapshot.queue);
    if (path === '/v1/queue/dlq') return json(200, { items: snapshot.dlq, count: snapshot.dlq.length, actions: snapshot.dlqActions });
    if (path === '/v1/workers') return json(200, { items: snapshot.workers });
    if (path === '/v1/tenants') return json(200, { items: snapshot.tenants });
    if (path === '/v1/experiments') return json(200, { items: snapshot.experiments });
    if (path === '/v1/metrics') {
      return { status: 200, contentType: 'text/plain; version=0.0.4', body: this.console.toPrometheus(snapshot) };
    }

    if (parts[0] === 'v1' && parts[1] === 'tenants' && parts[3] === 'limits' && parts.length === 4) {
      const tenantId = decodeURIComponent(parts[2] ?? '');
      const tenant = snapshot.tenants.find((entry) => entry.tenantId === tenantId);
      if (!tenant) return error(404, 'tenant_not_found', { tenantId });
      return json(200, tenant);
    }
    if (parts[0] === 'v1' && parts[1] === 'experiments' && parts.length === 3) {
      const experimentId = decodeURIComponent(parts[2] ?? '');
      const experiment = snapshot.experiments.find((entry) => entry.experimentId === experimentId);
      if (!experiment) return error(404, 'experiment_not_found', { experimentId });
      return json(200, experiment);
    }

    return error(404, 'not_found', { path });
  }

  /** POST /v1/queue/dlq/{jobId}/{retry|discard} */
  private async handlePost(request: StudioApiRequest, parts: string[]): Promise<StudioApiResponse> {
    const actor = resolveActor(request);
    const path = normalizePath(request.path);

    if (parts.length !== 5 || parts[0] !== 'v1' || parts[1] !== 'queue' || parts[2] !== 'dlq') {
      // A POST to an existing read route is "method not allowed" (405), not "missing" (404):
      // the difference tells a client whether to change the method or the path.
      if (isReadRoute(path)) {
        return {
          status: 405,
          contentType: 'application/json',
          headers: { allow: 'GET' },
          body: { error: 'method_not_allowed', method: 'POST', path },
        };
      }
      return error(404, 'not_found', { path });
    }

    const jobId = decodeURIComponent(parts[3] ?? '');
    const action = parts[4];
    if (action !== 'retry' && action !== 'discard') {
      return error(404, 'unknown_dlq_action', { action });
    }
    if (jobId === '') {
      return error(400, 'job_id_required', {});
    }

    const outcome = action === 'retry' ? await this.console.retryDlqJob(jobId, actor) : await this.console.discardDlqJob(jobId, actor);
    return {
      status: outcome.status,
      contentType: 'application/json',
      headers: { 'cache-control': 'no-store' },
      body: {
        ok: outcome.ok,
        action: outcome.action,
        jobId: outcome.jobId,
        state: outcome.state,
        message: outcome.message,
        at: outcome.at,
        // Not an error the caller can retry blindly: the same call will be refused again.
        retryable: false,
      },
    };
  }
}

/** Read routes the API exposes; used only to pick 405 over 404 for a wrong method. */
function isReadRoute(path: string): boolean {
  if (READ_ROUTES.has(path)) return true;
  if (/^\/v1\/tenants\/[^/]+\/limits$/.test(path)) return true;
  if (/^\/v1\/experiments\/[^/]+$/.test(path)) return true;
  return false;
}

const READ_ROUTES = new Set([
  '/',
  '/console',
  '/v1/health',
  '/v1/snapshot',
  '/v1/queue',
  '/v1/queue/dlq',
  '/v1/workers',
  '/v1/tenants',
  '/v1/experiments',
  '/v1/metrics',
]);

function resolveActor(request: StudioApiRequest): string {
  const fromBody = isRecord(request.body) && typeof request.body.actor === 'string' ? request.body.actor.trim() : '';
  if (fromBody !== '') return fromBody;
  const header = request.actor?.trim();
  return header && header !== '' ? header : 'operator';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function normalizePath(path: string): string {
  const withoutQuery = path.split('?')[0] ?? '';
  const trimmed = withoutQuery.length > 1 ? withoutQuery.replace(/\/+$/, '') : withoutQuery;
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

function json(status: number, body: unknown): StudioApiResponse {
  return { status, contentType: 'application/json', body };
}

function error(status: number, code: string, details: Record<string, unknown>): StudioApiResponse {
  return { status, contentType: 'application/json', body: { error: code, ...details } };
}

/** Snapshot helper for callers that want one shape regardless of route. */
export type { StudioSnapshot };
