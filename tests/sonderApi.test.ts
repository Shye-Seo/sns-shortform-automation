import { describe, expect, it } from 'vitest';
import { createChannelIdentityHandler } from '../api/channel-identity';
import { createGeneratePlanHandler } from '../api/generate-plan';
import { createHealthHandler, healthPayload } from '../api/health';
import { createAnalyzeHandler } from '../api/analyze-reference';
import { createPerformanceLogsHandler } from '../api/performance-logs';
import { createTrendVaultHandler } from '../api/trend-vault';
import { createMockResponse, type ApiRequest } from '../api/_lib/http';
import { createMemoryStore } from '../api/_lib/store';
import type { LlmClient } from '../api/_lib/llm';
import { IDENTITY_PRESETS } from '../src/services/sonder/identity';
import { analyzeReference } from '../src/services/sonder/reference';

const TRANSCRIPT = `3평 주방에서 매번 냄비를 꺼내다 부딪혔습니다.
수납장 문 안쪽 10cm를 그냥 버리고 있었거든요.
문 안쪽에 얇은 선반을 달고, 냄비 뚜껑은 같은 크기끼리 묶었습니다.
그다음 용기 높이를 맞춰서 세로로 세웠어요.
한 달 써보니 꺼내는 시간이 3초에서 1초로 줄었습니다.
오늘은 한 칸만 비워보세요. 저장해두고 천천히 해보세요.`;

const structure = analyzeReference({ title: '3평 주방 수납', transcript: TRANSCRIPT, durationSec: 32 }).structure;

async function call(
  handler: (req: ApiRequest, res: ReturnType<typeof createMockResponse>) => Promise<void>,
  req: ApiRequest,
) {
  const res = createMockResponse();
  await handler(req, res);
  return { status: res.status(), body: res.json() as Record<string, unknown> };
}

describe('health', () => {
  it('데이터베이스가 연결되면 connected, 없으면 missing이라고 답한다', async () => {
    const connected = await healthPayload({ env: { supabaseUrl: 'https://x.supabase.co', supabaseServiceKey: 'k' } as never, store: createMemoryStore() });
    expect(connected.database).toBe('connected');
    expect(connected.status).toBe('ok');

    const missing = await healthPayload({ env: {} as never, store: null });
    expect(missing.database).toBe('missing');
    expect(missing.ai).toBe('rules');
  });

  it('질의가 실패하면 연결됨이라고 하지 않는다', async () => {
    const store = createMemoryStore();
    const broken = { ...store, listIdentities: async () => Promise.reject(new Error('boom')) };
    const payload = await healthPayload({ env: {} as never, store: broken });
    expect(payload.database).toBe('error');
  });

  it('GET이 아니면 405', async () => {
    const { status } = await call(createHealthHandler({ store: createMemoryStore(), env: {} as never }), { method: 'POST' });
    expect(status).toBe(405);
  });
});

describe('channel-identity', () => {
  it('POST로 만들고 GET으로 읽고 PUT으로 고친다', async () => {
    const store = createMemoryStore();
    const handler = createChannelIdentityHandler(store);

    const created = await call(handler, {
      method: 'POST',
      body: { name: '일상·리빙', handle: '@shye__s', banned: '완벽, 무조건', strengths: ['실측 수납'] },
    });
    expect(created.status).toBe(201);
    const item = (created.body as { item: { id: string; banned: string[] } }).item;
    expect(item.banned).toEqual(['완벽', '무조건']);

    const updated = await call(handler, { method: 'PUT', body: { id: item.id, name: '일상·리빙 v2' } });
    expect(updated.status).toBe(200);
    expect((updated.body as { item: { name: string } }).item.name).toBe('일상·리빙 v2');

    const list = await call(handler, { method: 'GET' });
    expect((list.body as { items: unknown[] }).items).toHaveLength(1);
  });

  it('이름이 없으면 400, PUT에 id가 없으면 400', async () => {
    const handler = createChannelIdentityHandler(createMemoryStore());
    expect((await call(handler, { method: 'POST', body: { name: '' } })).status).toBe(400);
    expect((await call(handler, { method: 'PUT', body: { name: '이름만' } })).status).toBe(400);
    expect((await call(handler, { method: 'DELETE' })).status).toBe(405);
  });
});

describe('trend-vault', () => {
  it('저장할 때 배수를 서버에서 계산하고 목록 요약을 함께 돌려준다', async () => {
    const store = createMemoryStore();
    const handler = createTrendVaultHandler(store);
    const created = await call(handler, {
      method: 'POST',
      body: {
        url: 'https://www.youtube.com/shorts/abc123XYZ',
        title: '3평 주방 수납',
        transcript: TRANSCRIPT,
        views: 82000,
        medianViews: 19000,
        durationSec: 32,
        multiplier: 999,
      },
    });
    expect(created.status).toBe(201);
    const item = (created.body as { item: { multiplier: number; level: string; id: string } }).item;
    expect(item.multiplier).toBe(4.32);
    expect(item.level).toBe('viral');

    const list = await call(handler, { method: 'GET' });
    const summary = (list.body as { summary: { viralCount: number; count: number } }).summary;
    expect(summary.count).toBe(1);
    expect(summary.viralCount).toBe(1);

    const removed = await call(handler, { method: 'DELETE', url: `/api/trend-vault?id=${item.id}` });
    expect(removed.status).toBe(200);
    expect((removed.body as { removed: boolean }).removed).toBe(true);
    expect((await call(handler, { method: 'DELETE', url: '/api/trend-vault?id=none' })).status).toBe(404);
  });

  it('제목도 자막도 없으면 400', async () => {
    const handler = createTrendVaultHandler(createMemoryStore());
    const result = await call(handler, { method: 'POST', body: { url: 'https://youtu.be/abc123XYZ', views: 10 } });
    expect(result.status).toBe(400);
    expect((result.body as { error: string }).error).toContain('제목이나 자막');
  });
});

describe('analyze-reference', () => {
  it('유튜브 oEmbed에서 제목을 읽어 구조를 만든다', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ title: '3평 주방 수납, 문 안쪽 10cm', author_name: '숭구리' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;
    const handler = createAnalyzeHandler({ fetchImpl });
    const result = await call(handler, {
      method: 'POST',
      body: { url: 'https://www.youtube.com/shorts/abc123XYZ', transcript: TRANSCRIPT, durationSec: 32 },
    });
    expect(result.status).toBe(200);
    const body = result.body as { title: string; author: string; metadata: string; structure: { hookPattern: string } };
    expect(body.metadata).toBe('oembed');
    expect(body.title).toContain('3평 주방 수납');
    expect(body.author).toBe('숭구리');
    expect(body.structure.hookPattern).toBe('numbers');
  });

  it('oEmbed가 실패해도 사용자가 적은 제목으로 읽는다', async () => {
    const fetchImpl = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    const handler = createAnalyzeHandler({ fetchImpl });
    const result = await call(handler, {
      method: 'POST',
      body: { url: 'https://www.instagram.com/reel/Cxyz123/', title: '부산 골목 디카 산책' },
    });
    expect(result.status).toBe(200);
    expect((result.body as { metadata: string }).metadata).toBe('input');
    expect((result.body as { title: string }).title).toBe('부산 골목 디카 산책');
  });

  it('POST가 아니면 405', async () => {
    expect((await call(createAnalyzeHandler(), { method: 'GET' })).status).toBe(405);
  });
});

describe('generate-plan', () => {
  const identity = IDENTITY_PRESETS[0];

  it('채널과 구조로 기획안을 만들고 저장한다', async () => {
    const store = createMemoryStore();
    const handler = createGeneratePlanHandler({ store });
    const result = await call(handler, {
      method: 'POST',
      body: { topic: '부산 신혼집 3평 주방 수납 정리법', identity, structure, durationSec: 32 },
    });
    expect(result.status).toBe(200);
    const body = result.body as { plan: { hooks: unknown[]; scenes: unknown[]; source: string }; saved: boolean };
    expect(body.saved).toBe(true);
    expect(body.plan.hooks).toHaveLength(3);
    expect(body.plan.source).toBe('rules');
    expect((await store.listPlans())).toHaveLength(1);
  });

  it('같은 주제·구조면 훅을 바꿔도 한 행만 남는다', async () => {
    const store = createMemoryStore();
    const handler = createGeneratePlanHandler({ store });
    const first = await call(handler, {
      method: 'POST',
      body: { topic: '주방 수납 정리', identity, structure, durationSec: 32, chosenHook: 'A' },
    });
    const second = await call(handler, {
      method: 'POST',
      body: { topic: '주방 수납 정리', identity, structure, durationSec: 32, chosenHook: 'B' },
    });
    const firstId = (first.body as { plan: { id: string } }).plan.id;
    const secondId = (second.body as { plan: { id: string } }).plan.id;
    expect(secondId).toBe(firstId);
    expect(await store.listPlans()).toHaveLength(1);
  });

  it('모델이 있으면 그 문장을 쓰고 source를 남긴다', async () => {
    const store = createMemoryStore();
    const llm: LlmClient = {
      provider: 'openai',
      model: 'gpt-4o-mini',
      async complete() {
        return {
          hooks: [
            { pattern: 'question', text: '주방 수납, 왜 매번 막힐까요?' },
            { pattern: 'numbers', text: '세 칸만 비우면 됩니다' },
            { pattern: 'contrarian', text: '수납용품부터 사지 마세요' },
          ],
          scenes: [
            { beat: 'hook', narration: '주방 수납, 왜 매번 막힐까요?' },
            { beat: 'problem', narration: '문 안쪽 공간을 버리고 있었습니다.' },
            { beat: 'solution', narration: '문 안쪽에 얇은 선반을 답니다.' },
            { beat: 'cta', narration: '오늘 한 칸만 비워보세요. 저장해두세요.' },
          ],
        };
      },
    };
    const handler = createGeneratePlanHandler({ store, llm });
    const result = await call(handler, {
      method: 'POST',
      body: { topic: '주방 수납 정리', identity, structure, durationSec: 32 },
    });
    const body = result.body as { plan: { source: string; scenes: Array<{ narration: string }> } };
    expect(body.plan.source).toBe('openai');
    expect(body.plan.scenes.some((scene) => scene.narration.includes('얇은 선반'))).toBe(true);
  });

  it('모델 호출이 실패하면 내장 엔진으로 만들고 안내를 남긴다', async () => {
    const store = createMemoryStore();
    const llm: LlmClient = {
      provider: 'anthropic',
      model: 'claude',
      async complete() {
        throw new Error('429 rate limited');
      },
    };
    const handler = createGeneratePlanHandler({ store, llm });
    const result = await call(handler, {
      method: 'POST',
      body: { topic: '주방 수납 정리', identity, structure, durationSec: 32 },
    });
    expect(result.status).toBe(200);
    const body = result.body as { warning: string; plan: { source: string } };
    expect(body.plan.source).toBe('rules');
    expect(body.warning).toContain('내장 엔진');
  });

  it('주제·정체성·구조가 빠지면 400', async () => {
    const handler = createGeneratePlanHandler({ store: createMemoryStore() });
    expect((await call(handler, { method: 'POST', body: { topic: '주방' } })).status).toBe(400);
    expect(
      (await call(handler, { method: 'POST', body: { topic: '주방 수납', identity } })).status,
    ).toBe(400);
    expect(
      (await call(handler, { method: 'POST', body: { topic: '주방 수납', structure } })).status,
    ).toBe(400);
  });

  it('GET은 저장된 기획안을 돌려준다', async () => {
    const store = createMemoryStore();
    const handler = createGeneratePlanHandler({ store });
    await call(handler, {
      method: 'POST',
      body: { topic: '부산 신혼집 주방 수납', identity, structure, durationSec: 32 },
    });
    const list = await call(handler, { method: 'GET' });
    expect((list.body as { items: unknown[] }).items).toHaveLength(1);
  });
});

describe('performance-logs', () => {
  it('기록을 넣으면 배수와 저장률 요약을 돌려준다', async () => {
    const store = createMemoryStore();
    const handler = createPerformanceLogsHandler(store);
    const created = await call(handler, {
      method: 'POST',
      body: {
        title: '주방 수납 정리법',
        hookPattern: 'question',
        postedAt: '2026-11-21',
        views: 46000,
        saves: 1200,
        shares: 90,
        medianViews: 11500,
      },
    });
    expect(created.status).toBe(201);
    const item = (created.body as { item: { multiplier: number } }).item;
    expect(item.multiplier).toBe(4);

    const list = await call(handler, { method: 'GET' });
    const summary = (list.body as { summary: { count: number; saveRate: number; viralCount: number } }).summary;
    expect(summary.count).toBe(1);
    expect(summary.viralCount).toBe(1);
    expect(summary.saveRate).toBeCloseTo(1200 / 46000, 4);
  });

  it('제목이 없으면 400, 모르는 훅 패턴은 story로 둔다', async () => {
    const handler = createPerformanceLogsHandler(createMemoryStore());
    expect((await call(handler, { method: 'POST', body: { title: '' } })).status).toBe(400);
    const result = await call(handler, { method: 'POST', body: { title: '영상', hookPattern: '무엇' } });
    expect((result.body as { item: { hookPattern: string } }).item.hookPattern).toBe('story');
  });
});
