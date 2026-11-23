/**
 * GET/POST/PUT /api/channel-identity
 *
 * 채널 정체성은 계정마다 하나. id가 오면 그 채널을 덮어쓰고, 없으면 새로
 * 만든다. 저장 전에 `normalizeIdentity`가 길이와 빈 값을 정리하므로, 화면에서
 * 온 그대로 DB에 들어가지 않는다.
 */
import { normalizeIdentity } from '../src/services/sonder/identity';
import type { IdentityDraft } from '../src/services/sonder/types';
import { readEnv } from './_lib/env';
import {
  asRecord,
  fail,
  methodOf,
  readJsonBody,
  sendJson,
  stringList,
  textField,
  type ApiHandler,
} from './_lib/http';
import { DATABASE_MISSING_MESSAGE, storeFromEnv } from './_lib/runtime';
import type { Store } from './_lib/store';

function draftFromBody(body: Record<string, unknown>): IdentityDraft {
  return {
    id: textField(body, 'id') || undefined,
    name: textField(body, 'name'),
    handle: textField(body, 'handle'),
    posture: textField(body, 'posture'),
    audience: textField(body, 'audience'),
    voice: textField(body, 'voice'),
    strengths: stringList(body, 'strengths'),
    banned: stringList(body, 'banned'),
    signature: stringList(body, 'signature'),
  };
}

export function createChannelIdentityHandler(store: Store): ApiHandler {
  return async (req, res) => {
    const method = methodOf(req);

    if (method === 'GET') {
      const items = await store.listIdentities();
      sendJson(res, 200, { items });
      return;
    }

    if (method === 'POST' || method === 'PUT') {
      const body = asRecord(await readJsonBody(req));
      if (!body) {
        fail(res, 400, '채널 정보를 JSON으로 보내 주세요', 'invalid_body');
        return;
      }
      const draft = draftFromBody(body);
      if (method === 'PUT' && !draft.id) {
        fail(res, 400, '수정할 채널 id가 필요합니다', 'missing_id');
        return;
      }
      try {
        const identity = normalizeIdentity(draft);
        const item = await store.putIdentity(identity);
        sendJson(res, method === 'POST' ? 201 : 200, { item });
      } catch (error) {
        fail(res, 400, error instanceof Error ? error.message : '채널 정보를 저장하지 못했습니다');
      }
      return;
    }

    fail(res, 405, 'GET·POST·PUT만 지원합니다', 'method_not_allowed');
  };
}

export default async function handler(req: Parameters<ApiHandler>[0], res: Parameters<ApiHandler>[1]): Promise<void> {
  const store = storeFromEnv(readEnv());
  if (!store) {
    fail(res, 503, DATABASE_MISSING_MESSAGE, 'database_not_configured');
    return;
  }
  await createChannelIdentityHandler(store)(req, res);
}
