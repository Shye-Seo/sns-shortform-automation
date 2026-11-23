/**
 * GET/POST /api/performance-logs
 *
 * 올린 영상의 숫자를 남기고, 그 요약을 다음 기획안이 읽는다. 배수는 기록 시점의
 * 평소 중간값으로 계산해 함께 저장한다 — 나중에 중간값이 바뀌어도 그때의 판정은
 * 그대로 남는다.
 */
import { summarizeLogs, withMultiplier } from '../src/services/sonder/performance';
import { sonderId, type HookPattern, type PerformanceLog } from '../src/services/sonder/types';
import { readEnv } from './_lib/env';
import {
  asRecord,
  fail,
  methodOf,
  numberField,
  readJsonBody,
  sendJson,
  textField,
  type ApiHandler,
} from './_lib/http';
import { DATABASE_MISSING_MESSAGE, storeFromEnv } from './_lib/runtime';
import type { Store } from './_lib/store';

const PATTERNS: HookPattern[] = ['question', 'numbers', 'howto', 'contrarian', 'story'];

export function createPerformanceLogsHandler(store: Store): ApiHandler {
  return async (req, res) => {
    const method = methodOf(req);

    if (method === 'GET') {
      const items = await store.listLogs();
      sendJson(res, 200, { items, summary: summarizeLogs(items) });
      return;
    }

    if (method === 'POST') {
      const body = asRecord(await readJsonBody(req));
      if (!body) {
        fail(res, 400, '성과 기록을 JSON으로 보내 주세요', 'invalid_body');
        return;
      }
      const title = textField(body, 'title');
      if (title.length === 0) {
        fail(res, 400, '영상 제목을 넣어 주세요', 'missing_title');
        return;
      }
      const patternText = textField(body, 'hookPattern');
      const postedAt = textField(body, 'postedAt') || new Date().toISOString().slice(0, 10);

      const log: PerformanceLog = withMultiplier({
        id: sonderId('log'),
        planId: textField(body, 'planId') || null,
        title,
        hookPattern: PATTERNS.includes(patternText as HookPattern) ? (patternText as HookPattern) : 'story',
        postedAt,
        views: Math.max(0, Math.round(numberField(body, 'views'))),
        saves: Math.max(0, Math.round(numberField(body, 'saves'))),
        shares: Math.max(0, Math.round(numberField(body, 'shares'))),
        follows: Math.max(0, Math.round(numberField(body, 'follows'))),
        medianViews: Math.max(0, Math.round(numberField(body, 'medianViews'))),
        createdAt: new Date().toISOString(),
      });

      const item = await store.addLog(log);
      const items = await store.listLogs();
      sendJson(res, 201, { item, summary: summarizeLogs(items) });
      return;
    }

    fail(res, 405, 'GET·POST만 지원합니다', 'method_not_allowed');
  };
}

export default async function handler(req: Parameters<ApiHandler>[0], res: Parameters<ApiHandler>[1]): Promise<void> {
  const store = storeFromEnv(readEnv());
  if (!store) {
    fail(res, 503, DATABASE_MISSING_MESSAGE, 'database_not_configured');
    return;
  }
  await createPerformanceLogsHandler(store)(req, res);
}
