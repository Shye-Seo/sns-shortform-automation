/**
 * Vercel Node 함수의 요청·응답 도우미.
 *
 * `@vercel/node` 타입을 devDependency로 끌어오지 않으려고, 이 저장소가 실제로
 * 쓰는 부분(method, query, body, statusCode, setHeader, end)만 타입으로 적는다.
 * 단위 테스트는 같은 모양의 가짜 객체를 넘기면 된다.
 */

export interface ApiRequest {
  method?: string;
  url?: string;
  headers?: Record<string, string | string[] | undefined>;
  query?: Record<string, string | string[] | undefined>;
  body?: unknown;
}

export interface ApiResponse {
  statusCode: number;
  setHeader(name: string, value: string): unknown;
  end(chunk?: string): unknown;
}

export type ApiHandler = (req: ApiRequest, res: ApiResponse) => Promise<void>;

export function sendJson(res: ApiResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(body));
}

export function fail(res: ApiResponse, status: number, message: string, code?: string): void {
  sendJson(res, status, { error: message, code: code ?? 'invalid_request' });
}

export function methodOf(req: ApiRequest): string {
  return (req.method ?? 'GET').toUpperCase();
}

/** `/api/x?id=1`의 id. Vercel은 query를 미리 채워 주지만 테스트는 URL만 준다. */
export function queryValue(req: ApiRequest, key: string): string | undefined {
  const direct = req.query?.[key];
  if (typeof direct === 'string') return direct;
  if (Array.isArray(direct)) return direct[0];
  if (req.url) {
    const url = new URL(req.url, 'http://localhost');
    const value = url.searchParams.get(key);
    if (value !== null) return value;
  }
  return undefined;
}

/** 본문은 Vercel이 객체로 파싱해 주지만, 문자열로 들어오는 경우도 받는다. */
export async function readJsonBody(req: ApiRequest): Promise<unknown> {
  if (req.body === undefined || req.body === null) return null;
  if (typeof req.body === 'string') {
    try {
      return JSON.parse(req.body);
    } catch {
      return null;
    }
  }
  return req.body;
}

/** 본문이 객체인지 확인하고, 아니면 400을 보낸다. */
export function asRecord(body: unknown): Record<string, unknown> | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  return body as Record<string, unknown>;
}

export function textField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

export function numberField(record: Record<string, unknown>, key: string, fallback = 0): number {
  const value = record[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value.replace(/[, ]/g, ''));
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

export function stringList(record: Record<string, unknown>, key: string, max = 12): string[] {
  const value = record[key];
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean).slice(0, max);
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(0, max);
  }
  return [];
}

/** 테스트에서 응답을 읽기 쉽게 만드는 작은 수집기. */
export function createMockResponse(): ApiResponse & { status: () => number; json: () => unknown } {
  let payload = '';
  const res: ApiResponse = {
    statusCode: 200,
    setHeader: () => undefined,
    end: (chunk?: string) => {
      payload = chunk ?? '';
    },
  };
  return Object.assign(res, {
    status: () => res.statusCode,
    json: () => {
      try {
        return JSON.parse(payload);
      } catch {
        return null;
      }
    },
  });
}
