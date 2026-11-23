/**
 * GET /api/health
 *
 * 화면은 이 응답 하나로 로컬 모드와 클라우드 모드를 가른다. 그래서 "설정이
 * 있다"가 아니라 "지금 읽힌다"를 확인한다. Supabase에 실제로 한 번 질의해
 * 실패하면 `error`로 돌려주고, 화면은 로컬 모드로 남는다.
 */
import { aiProvider, readEnv, type SonderEnv } from './_lib/env';
import { fail, methodOf, sendJson, type ApiHandler } from './_lib/http';
import { storeFromEnv } from './_lib/runtime';
import type { Store } from './_lib/store';

export interface HealthDeps {
  env?: SonderEnv;
  store?: Store | null;
}

export type DatabaseState = 'connected' | 'missing' | 'error';

export interface HealthPayload {
  status: 'ok';
  database: DatabaseState;
  ai: 'openai' | 'anthropic' | 'rules';
  version: number;
  checkedAt: string;
}

export async function probeDatabase(store: Store | null): Promise<DatabaseState> {
  if (!store) return 'missing';
  try {
    await store.listIdentities();
    return 'connected';
  } catch {
    return 'error';
  }
}

export async function healthPayload(deps: HealthDeps = {}): Promise<HealthPayload> {
  const env = deps.env ?? readEnv();
  const store = deps.store !== undefined ? deps.store : storeFromEnv(env);
  const database = await probeDatabase(store);
  return {
    status: 'ok',
    database,
    ai: aiProvider(env),
    version: 1,
    checkedAt: new Date().toISOString(),
  };
}

export function createHealthHandler(deps: HealthDeps = {}): ApiHandler {
  return async (req, res) => {
    if (methodOf(req) !== 'GET') {
      fail(res, 405, 'GET만 지원합니다', 'method_not_allowed');
      return;
    }
    sendJson(res, 200, await healthPayload(deps));
  };
}

export default async function handler(req: Parameters<ApiHandler>[0], res: Parameters<ApiHandler>[1]): Promise<void> {
  await createHealthHandler()(req, res);
}
