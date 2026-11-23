/**
 * GET/POST/DELETE /api/trend-vault
 *
 * 저장할 때 배수와 판정을 서버에서 다시 계산한다. 화면이 보낸 배수를 믿으면
 * 조회수를 고쳐 보낼 수 있고, 무엇보다 그 숫자가 어디서 나왔는지 남지 않는다.
 */
import { analyzeReference } from '../src/services/sonder/reference';
import { sonderId, type TrendItem } from '../src/services/sonder/types';
import { summarizeVault, viralVerdict } from '../src/services/sonder/viral';
import { readEnv } from './_lib/env';
import {
  asRecord,
  fail,
  methodOf,
  numberField,
  queryValue,
  readJsonBody,
  sendJson,
  textField,
  type ApiHandler,
} from './_lib/http';
import { DATABASE_MISSING_MESSAGE, storeFromEnv } from './_lib/runtime';
import type { Store } from './_lib/store';

export function createTrendVaultHandler(store: Store): ApiHandler {
  return async (req, res) => {
    const method = methodOf(req);

    if (method === 'GET') {
      const items = await store.listTrends();
      sendJson(res, 200, { items, summary: summarizeVault(items) });
      return;
    }

    if (method === 'POST') {
      const body = asRecord(await readJsonBody(req));
      if (!body) {
        fail(res, 400, '참고 영상 정보를 JSON으로 보내 주세요', 'invalid_body');
        return;
      }
      const views = numberField(body, 'views');
      const medianViews = numberField(body, 'medianViews');
      try {
        const analysis = analyzeReference({
          url: textField(body, 'url'),
          title: textField(body, 'title') || undefined,
          transcript: textField(body, 'transcript') || undefined,
          durationSec: numberField(body, 'durationSec') || undefined,
          author: textField(body, 'author') || undefined,
        });
        const verdict = viralVerdict(views, medianViews);
        const item: TrendItem = {
          id: sonderId('trend'),
          url: textField(body, 'url'),
          title: analysis.title,
          author: analysis.author,
          transcript: textField(body, 'transcript'),
          views: Math.max(0, Math.round(views)),
          medianViews: Math.max(0, Math.round(medianViews)),
          multiplier: verdict.multiplier,
          level: verdict.level,
          structure: analysis.structure,
          note: textField(body, 'note'),
          savedAt: new Date().toISOString(),
        };
        const saved = await store.addTrend(item);
        const items = await store.listTrends();
        sendJson(res, 201, { item: saved, summary: summarizeVault(items) });
      } catch (error) {
        fail(res, 400, error instanceof Error ? error.message : '참고 영상을 저장하지 못했습니다');
      }
      return;
    }

    if (method === 'DELETE') {
      const id = queryValue(req, 'id');
      if (!id) {
        fail(res, 400, '삭제할 항목 id가 필요합니다', 'missing_id');
        return;
      }
      const removed = await store.removeTrend(id);
      if (!removed) {
        fail(res, 404, '해당 항목을 찾지 못했습니다', 'not_found');
        return;
      }
      const items = await store.listTrends();
      sendJson(res, 200, { removed: true, summary: summarizeVault(items) });
      return;
    }

    fail(res, 405, 'GET·POST·DELETE만 지원합니다', 'method_not_allowed');
  };
}

export default async function handler(req: Parameters<ApiHandler>[0], res: Parameters<ApiHandler>[1]): Promise<void> {
  const store = storeFromEnv(readEnv());
  if (!store) {
    fail(res, 503, DATABASE_MISSING_MESSAGE, 'database_not_configured');
    return;
  }
  await createTrendVaultHandler(store)(req, res);
}
