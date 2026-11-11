import type { StudioConsole, StudioSnapshot } from './console';

export interface StudioApiRequest {
  method: string;
  path: string;
}

export interface StudioApiResponse {
  status: number;
  contentType: string;
  headers?: Record<string, string>;
  body: unknown;
}

/**
 * Read-only HTTP surface over `StudioConsole`.
 *
 * Deliberately narrow: no mutation endpoints. A dashboard that can replay a
 * DLQ job with a GET is a dashboard that will eventually replay one by
 * accident. Mutations stay in the CLI, where they are deliberate.
 */
export class StudioApi {
  constructor(private readonly console: StudioConsole) {}

  async handle(request: StudioApiRequest): Promise<StudioApiResponse> {
    const method = request.method.toUpperCase();
    const path = normalizePath(request.path);
    if (method !== 'GET') {
      return {
        status: 405,
        contentType: 'application/json',
        headers: { allow: 'GET' },
        body: { error: 'method_not_allowed', method },
      };
    }

    const snapshot = await this.console.snapshot();
    const parts = path.split('/').filter(Boolean);

    if (path === '/v1/health') {
      return json(200, { status: snapshot.health.status, reasons: snapshot.health.reasons, generatedAt: snapshot.generatedAt });
    }
    if (path === '/v1/snapshot') return json(200, snapshot);
    if (path === '/v1/queue') return json(200, snapshot.queue);
    if (path === '/v1/queue/dlq') return json(200, { items: snapshot.dlq, count: snapshot.dlq.length });
    if (path === '/v1/workers') return json(200, { items: snapshot.workers });
    if (path === '/v1/tenants') return json(200, { items: snapshot.tenants });
    if (path === '/v1/experiments') return json(200, { items: snapshot.experiments });
    if (path === '/v1/metrics') {
      return { status: 200, contentType: 'text/plain; version=0.0.4', body: this.console.toPrometheus(snapshot) };
    }

    if (parts[0] === 'v1' && parts[1] === 'tenants' && parts[3] === 'limits' && parts.length === 4) {
      const tenantId = decodeURIComponent(parts[2]);
      const tenant = snapshot.tenants.find((entry) => entry.tenantId === tenantId);
      if (!tenant) return error(404, 'tenant_not_found', { tenantId });
      return json(200, tenant);
    }
    if (parts[0] === 'v1' && parts[1] === 'experiments' && parts.length === 3) {
      const experimentId = decodeURIComponent(parts[2]);
      const experiment = snapshot.experiments.find((entry) => entry.experimentId === experimentId);
      if (!experiment) return error(404, 'experiment_not_found', { experimentId });
      return json(200, experiment);
    }

    return error(404, 'not_found', { path });
  }
}

function normalizePath(path: string): string {
  const withoutQuery = path.split('?')[0];
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
