import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { StudioApi, StudioApiRequest } from './api';
import type { StudioConsole } from './console';

/**
 * Studio console HTTP server — the page and the action buttons on one origin.
 *
 * Why a server at all
 * -------------------
 * The console HTML can be written to disk (`studio --html`), but a file:// page
 * cannot POST to the DLQ endpoints, so its "재시도 / 폐기" buttons would be
 * decoration. Serving the same HTML from this process makes them real: the page
 * and the mutation API share an origin, and a click is one request.
 *
 * Scope: a single-node operator console, not a public service.
 *   - binds to 127.0.0.1 by default (an ops UI should not be reachable from the
 *     network until someone decides to expose it)
 *   - no auth — it sits behind the same tunnel/VPN as the operator
 *   - POST bodies are capped (32 KB) because only `{actor}` is expected
 *   - only two mutating routes exist, and both are idempotent-by-refusal (a
 *     second retry of an already-requeued job is rejected by the state check)
 */

export interface StudioServerOptions {
  console: StudioConsole;
  api: StudioApi;
  host?: string;
  port?: number;
  /** Operator name recorded in the DLQ log when the request does not name one. */
  actor?: string;
}

export interface StudioServerHandle {
  server: Server;
  url: string;
  port: number;
  close: () => Promise<void>;
}

const MAX_BODY_BYTES = 32 * 1024;

export function createStudioServer(options: StudioServerOptions): Server {
  const { api, actor } = options;
  return createServer(async (request, response) => {
    try {
      const body = await readBody(request);
      const apiRequest: StudioApiRequest = {
        method: request.method ?? 'GET',
        path: request.url ?? '/',
        body: body.json,
        actor: headerValue(request, 'x-operator') ?? actor,
      };
      const result = await api.handle(apiRequest);
      const payload = typeof result.body === 'string' ? result.body : JSON.stringify(result.body, null, 2);
      response.writeHead(result.status, {
        'content-type': result.contentType,
        'content-length': Buffer.byteLength(payload),
        ...(result.headers ?? {}),
      });
      response.end(payload);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unexpected server error';
      const payload = JSON.stringify({ error: 'internal_error', message });
      response.writeHead(500, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
      response.end(payload);
    }
  });
}

/** Start on the requested port (0 = OS-assigned, which the tests use). */
export async function startStudioServer(options: StudioServerOptions): Promise<StudioServerHandle> {
  const host = options.host ?? '127.0.0.1';
  const server = createStudioServer(options);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : (options.port ?? 0);
  return {
    server,
    port,
    url: `http://${host}:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

async function readBody(request: IncomingMessage): Promise<{ json: unknown }> {
  if (request.method !== 'POST') {
    // Drain nothing on GET; just make sure the socket does not stay open.
    request.resume();
    return { json: undefined };
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      throw new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`);
    }
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (raw === '') return { json: undefined };
  const contentType = request.headers['content-type'] ?? '';
  // Anything that is not JSON is ignored rather than parsed: the only field we
  // read is `actor`, and a form-encoded body cannot be trusted to be shaped right.
  if (!String(contentType).includes('json')) return { json: undefined };
  try {
    return { json: JSON.parse(raw) as unknown };
  } catch {
    return { json: undefined };
  }
}

function headerValue(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  if (Array.isArray(value)) return value[0];
  return typeof value === 'string' ? value : undefined;
}
