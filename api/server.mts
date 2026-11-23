/**
 * 로컬 API 서버 — `npm run dev:api`.
 *
 * Vercel 함수 파일 그대로를 Node http 서버에 물린다. 데이터베이스가 설정되어
 * 있으면 Supabase에, 없으면 메모리에 저장한다. 배포 전에 엔드포인트 동작을
 * 확인하는 데 쓴다.
 */
import { createServer } from 'node:http';
import { readEnv } from './_lib/env.js';
import { createMemoryStore } from './_lib/store.js';
import { storeFromEnv } from './_lib/runtime.js';
import { createHealthHandler } from './health.js';
import { createChannelIdentityHandler } from './channel-identity.js';
import { createTrendVaultHandler } from './trend-vault.js';
import { createAnalyzeHandler } from './analyze-reference.js';
import { createGeneratePlanHandler } from './generate-plan.js';
import { createPerformanceLogsHandler } from './performance-logs.js';
import { llmFromEnv } from './_lib/llm.js';

const env = readEnv();
const store = storeFromEnv(env) ?? createMemoryStore();

/** 본문 크기 제한. 자막 붙여넣기가 큰 편이라 넉넉히 잡는다. */
const MAX_BODY = 2 * 1024 * 1024;

const routes: Array<{ prefix: string; handler: (req: unknown, res: unknown) => Promise<void> }> = [
  { prefix: '/api/health', handler: createHealthHandler({ env, store }) as never },
  { prefix: '/api/channel-identity', handler: createChannelIdentityHandler(store) as never },
  { prefix: '/api/trend-vault', handler: createTrendVaultHandler(store) as never },
  { prefix: '/api/analyze-reference', handler: createAnalyzeHandler() as never },
  { prefix: '/api/generate-plan', handler: createGeneratePlanHandler({ store, llm: llmFromEnv(env) }) as never },
  { prefix: '/api/performance-logs', handler: createPerformanceLogsHandler(store) as never },
];

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const route = routes.find((item) => url.pathname === item.prefix);
  if (!route) {
    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: '없는 주소입니다', code: 'not_found' }));
    return;
  }

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) {
      res.writeHead(413, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: '본문이 너무 큽니다', code: 'payload_too_large' }));
      req.destroy();
      return;
    }
    chunks.push(chunk as Buffer);
  }

  const bodyText = Buffer.concat(chunks).toString('utf8');
  const request = {
    method: req.method,
    url: req.url,
    headers: req.headers,
    query: Object.fromEntries(url.searchParams.entries()),
    body: bodyText,
  };

  try {
    await route.handler(request, res);
  } catch (error) {
    console.error(error);
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
    }
    res.end(JSON.stringify({ error: '서버 오류', detail: String(error) }));
  }
});

const port = Number(process.env.PORT ?? 3000);
server.listen(port, '127.0.0.1', () => {
  console.log(`API server on http://127.0.0.1:${port} — db: ${store.kind}, ai: ${env.openaiKey || env.anthropicKey ? 'key set' : 'rules'}`);
});
