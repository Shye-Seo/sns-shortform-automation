import { ShortformError } from '../../lib/errors';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';

export interface HttpRequest {
  method: HttpMethod;
  url: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  timeoutMs?: number;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export type HttpClient = (request: HttpRequest) => Promise<HttpResponse>;

export interface FetchClientOptions {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export function createFetchClient(options: FetchClientOptions = {}): HttpClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const defaultTimeout = options.timeoutMs ?? 60_000;

  return async (request: HttpRequest): Promise<HttpResponse> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), request.timeoutMs ?? defaultTimeout);
    try {
      const response = await fetchImpl(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body as unknown as RequestInit['body'],
        signal: controller.signal,
      });
      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        headers[key.toLowerCase()] = value;
      });
      const body = await response.text();
      return { status: response.status, headers, body };
    } catch (error) {
      throw new ShortformError(`network error on ${request.method} ${redactUrl(request.url)}`, {
        code: 'NETWORK',
        retryable: true,
        cause: error,
        details: { method: request.method, url: redactUrl(request.url) },
      });
    } finally {
      clearTimeout(timer);
    }
  };
}

/** Never print an access token that arrived as a query parameter. */
export function redactUrl(url: string): string {
  return url.replace(/([?&](?:access_token|key|api_key|token)=)[^&]+/gi, '$1***');
}

export function parseJson<T>(response: HttpResponse): T {
  try {
    return JSON.parse(response.body) as T;
  } catch (error) {
    throw new ShortformError('platform returned a non-JSON body', {
      code: 'PLATFORM',
      retryable: response.status >= 500 || response.status === 429,
      cause: error,
      details: { status: response.status, body: response.body.slice(0, 300) },
    });
  }
}

interface MetaErrorBody {
  error?: {
    message?: string;
    type?: string;
    code?: number;
    error_subcode?: number;
    error_user_msg?: string;
    fbtrace_id?: string;
  };
}

interface GoogleErrorBody {
  error?: {
    code?: number;
    message?: string;
    status?: string;
    errors?: Array<{ reason?: string; message?: string; domain?: string }>;
  };
}

export interface PlatformErrorInfo {
  message: string;
  status: number;
  code?: string | number;
  subcode?: number;
  traceId?: string;
  userMessage?: string;
  retryAfterMs?: number;
}

/** Parse a Meta Graph error payload. */
export function parseMetaError(response: HttpResponse): PlatformErrorInfo {
  try {
    const body = JSON.parse(response.body) as MetaErrorBody;
    const error = body.error ?? {};
    return {
      message: error.message ?? `Graph API error (${response.status})`,
      status: response.status,
      code: error.code,
      subcode: error.error_subcode,
      traceId: error.fbtrace_id,
      userMessage: error.error_user_msg,
      retryAfterMs: retryAfterFromHeaders(response.headers),
    };
  } catch {
    return {
      message: `Graph API error (${response.status})`,
      status: response.status,
      retryAfterMs: retryAfterFromHeaders(response.headers),
    };
  }
}

/** Parse a Google API error payload. */
export function parseGoogleError(response: HttpResponse): PlatformErrorInfo {
  try {
    const body = JSON.parse(response.body) as GoogleErrorBody;
    const error = body.error ?? {};
    return {
      message: error.message ?? `YouTube API error (${response.status})`,
      status: response.status,
      code: error.status ?? error.code,
      retryAfterMs: retryAfterFromHeaders(response.headers),
    };
  } catch {
    return {
      message: `YouTube API error (${response.status})`,
      status: response.status,
      retryAfterMs: retryAfterFromHeaders(response.headers),
    };
  }
}

export function retryAfterFromHeaders(headers: Record<string, string>): number | undefined {
  const retryAfter = headers['retry-after'];
  if (!retryAfter) return undefined;
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(retryAfter);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return undefined;
}

/** Meta rate-limit codes that mean "wait", not "fail". */
const META_RATE_LIMIT_CODES = new Set([4, 17, 32, 613, 80004]);

export function isRetryablePlatformError(info: PlatformErrorInfo, provider: 'meta' | 'google'): boolean {
  if (info.status === 429) return true;
  if (info.status >= 500) return true;
  if (provider === 'meta' && typeof info.code === 'number' && META_RATE_LIMIT_CODES.has(info.code)) {
    return true;
  }
  if (provider === 'google' && info.code === 'RESOURCE_EXHAUSTED') return true;
  return false;
}

export class PlatformApiError extends ShortformError {
  constructor(
    readonly provider: 'meta' | 'google',
    readonly info: PlatformErrorInfo,
    context: string,
  ) {
    super(`${context}: ${info.message}`, {
      code: info.status === 429 ? 'RATE_LIMIT' : 'PLATFORM',
      retryable: isRetryablePlatformError(info, provider),
      details: {
        status: info.status,
        code: info.code,
        subcode: info.subcode,
        traceId: info.traceId,
        userMessage: info.userMessage,
        retryAfterMs: info.retryAfterMs,
      },
    });
    this.name = 'PlatformApiError';
  }
}

export function assertOk(
  response: HttpResponse,
  provider: 'meta' | 'google',
  context: string,
): HttpResponse {
  if (response.status >= 200 && response.status < 300) return response;
  const info = provider === 'meta' ? parseMetaError(response) : parseGoogleError(response);
  throw new PlatformApiError(provider, info, context);
}

export async function jsonRequest<T>(
  http: HttpClient,
  provider: 'meta' | 'google',
  request: HttpRequest,
  context: string,
): Promise<{ data: T; response: HttpResponse }> {
  const response = await http(request);
  assertOk(response, provider, context);
  return { data: parseJson<T>(response), response };
}
