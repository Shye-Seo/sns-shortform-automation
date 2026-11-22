import { describe, expect, it } from 'vitest';
import { buildAiScriptPrompt } from '../src/services/aiScriptPrompt';
import { classifyScriptDomain } from '../src/services/scriptDomains';
import { resolveDomainAngle } from '../src/services/domainScriptWriter';
import {
  AI_STORAGE_KEY,
  AiScriptError,
  clearAiConfig,
  extractCompletionText,
  generateDraftsWithAi,
  loadAiConfig,
  saveAiConfig,
  type AiConfig,
} from '../web/model/aiScript';

/**
 * 선택형 LLM 연결(BYOK).
 *
 * 정적 데모에는 서버가 없으므로 키는 브라우저에만 남고, 호출은 제공자 API로
 * 바로 나간다. 이 테스트는 (1) 프롬프트가 주제의 실제 확인 포인트를 싣는지,
 * (2) 두 제공자의 요청 형식과 응답 파싱, (3) 실패 메시지와 저장 동작을 고정한다.
 */

const OPENAI_OK = {
  choices: [
    {
      message: {
        content: JSON.stringify({
          title: '전세사기 3분 점검',
          scenes: [
            { beat: 'hook', narration: 'AI가 만든 훅: 전세사기, 서류 세 장이면 갈립니다' },
            { beat: 'problem', narration: 'AI가 만든 문제: 등기부등본을 한 번만 떼면 근저당을 놓칩니다.' },
            { beat: 'solution', narration: 'AI가 만든 해결: 잔금 당일 전입신고와 확정일자를 같이 처리합니다.' },
            { beat: 'solution', narration: 'AI가 만든 해결: HUG 가입 여부를 특약에 넣습니다.' },
            { beat: 'solution', narration: 'AI가 만든 해결: 보증금은 임대인 본인 계좌로 보냅니다.' },
            { beat: 'cta', narration: '계약 전에 다시 보려면 저장해두세요.' },
          ],
          hashtags: ['#전세사기'],
        }),
      },
    },
  ],
};

const ANTHROPIC_OK = {
  content: [
    {
      type: 'text',
      text: JSON.stringify({
        title: '전세사기 점검',
        scenes: [
          { beat: 'hook', narration: 'Claude 훅: 전세사기 서류 세 장' },
          { beat: 'problem', narration: 'Claude 문제: 등기부등본 확인 시점.' },
          { beat: 'solution', narration: 'Claude 해결: 확정일자를 같은 날.' },
          { beat: 'cta', narration: '저장해두세요.' },
        ],
      }),
    },
  ],
};

function fakeStorage(): Storage & { dump(): Record<string, string> } {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
    clear: () => map.clear(),
    key: (index: number) => [...map.keys()][index] ?? null,
    get length() {
      return map.size;
    },
    dump: () => Object.fromEntries(map),
  } as Storage & { dump(): Record<string, string> };
}

interface Captured {
  url: string;
  init: { method: string; headers: Record<string, string>; body: string };
}

function stubFetch(response: { ok: boolean; status: number; payload: unknown }): {
  fetchImpl: (url: string, init: Captured['init']) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
  calls: Captured[];
} {
  const calls: Captured[] = [];
  return {
    calls,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return { ok: response.ok, status: response.status, json: async () => response.payload };
    },
  };
}

const CONFIG: AiConfig = { provider: 'openai', model: 'gpt-4o-mini', apiKey: 'sk-test-1234' };

describe('AI 대본 프롬프트', () => {
  it('주제·도메인·실제 확인 포인트를 프롬프트에 넣는다', () => {
    const topic = '전세사기 주의할점';
    const domain = classifyScriptDomain(topic);
    const prompt = buildAiScriptPrompt({
      topic,
      durationSec: 60,
      language: 'ko',
      angle: resolveDomainAngle('auto', topic, 0),
      ctaGoal: 'save',
      domain,
    });

    expect(prompt.system).toContain('3.5초');
    expect(prompt.user).toContain(topic);
    expect(prompt.user).toContain('집·부동산');
    expect(prompt.user).toContain('등기부등본');
    expect(prompt.user).toContain('HUG');
    expect(prompt.user).toContain('공고에서 확인');
    expect(prompt.user).toContain('"scenes"');
    // 같은 주제에 붙는 범용 조언을 금지한다.
    expect(prompt.user).toContain('범용 조언');
    // 60초 발화 예산이 숫자로 들어간다.
    expect(prompt.user).toMatch(/speech budget: about \d+/);
  });

  it('지식 팩이 없는 주제도 도메인만으로 프롬프트를 만든다', () => {
    const topic = '주말 아침 브이로그';
    const prompt = buildAiScriptPrompt({
      topic,
      durationSec: 30,
      language: 'ko',
      ctaGoal: 'comment',
      domain: classifyScriptDomain(topic),
    });
    expect(prompt.user).toContain('일상·브이로그');
    expect(prompt.user).toContain('댓글');
    expect(prompt.user).not.toContain('[이 주제에서 실제로 확인해야 하는 포인트]');
  });
});

describe('제공자 호출', () => {
  it('OpenAI는 chat completions에 JSON 모드를 걸고 대본을 파싱한다', async () => {
    const stub = stubFetch({ ok: true, status: 200, payload: OPENAI_OK });
    const result = await generateDraftsWithAi(CONFIG, { topic: '전세사기 주의할점', durationSec: 60 }, stub.fetchImpl);

    expect(stub.calls).toHaveLength(1);
    const call = stub.calls[0]!;
    expect(call.url).toContain('api.openai.com');
    expect(call.init.headers.authorization).toBe('Bearer sk-test-1234');
    const body = JSON.parse(call.init.body) as {
      model: string;
      response_format: { type: string };
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.model).toBe('gpt-4o-mini');
    expect(body.response_format.type).toBe('json_object');
    expect(body.messages[0]?.role).toBe('system');
    expect(body.messages[1]?.content).toContain('등기부등본');

    expect(result.drafts.map((draft) => draft.beat)).toEqual([
      'hook',
      'problem',
      'solution',
      'solution',
      'solution',
      'cta',
    ]);
    expect(result.drafts[0]?.narration).toContain('AI가 만든 훅');
    expect(result.model).toBe('gpt-4o-mini');
  });

  it('Anthropic은 브라우저 직접 호출 헤더와 messages API를 쓴다', async () => {
    const stub = stubFetch({ ok: true, status: 200, payload: ANTHROPIC_OK });
    const result = await generateDraftsWithAi(
      { provider: 'anthropic', model: 'claude-sonnet-4-5', apiKey: 'sk-ant-test' },
      { topic: '전세사기 주의할점', durationSec: 45 },
      stub.fetchImpl,
    );

    const call = stub.calls[0]!;
    expect(call.url).toContain('api.anthropic.com');
    expect(call.init.headers['x-api-key']).toBe('sk-ant-test');
    expect(call.init.headers['anthropic-version']).toBe('2023-06-01');
    expect(call.init.headers['anthropic-dangerous-direct-browser-access']).toBe('true');
    const body = JSON.parse(call.init.body) as { system: string; max_tokens: number };
    expect(body.system).toContain('3.5초');
    expect(body.max_tokens).toBeGreaterThan(500);
    expect(result.drafts[0]?.narration).toContain('Claude 훅');
  });

  it('키가 거절되면 다시 확인하라는 메시지를 준다', async () => {
    const stub = stubFetch({ ok: false, status: 401, payload: { error: { message: 'invalid api key' } } });
    await expect(
      generateDraftsWithAi(CONFIG, { topic: '전세사기 주의할점', durationSec: 60 }, stub.fetchImpl),
    ).rejects.toThrow(/키가 거절되었습니다/);
  });

  it('대본 형식이 아닌 응답은 형식 오류로 알린다', async () => {
    const stub = stubFetch({
      ok: true,
      status: 200,
      payload: { choices: [{ message: { content: '미안하지만 대본을 만들 수 없어요.' } }] },
    });
    await expect(
      generateDraftsWithAi(CONFIG, { topic: '전세사기 주의할점', durationSec: 60 }, stub.fetchImpl),
    ).rejects.toThrow(AiScriptError);
  });

  it('키가 비어 있으면 호출하지 않는다', async () => {
    const stub = stubFetch({ ok: true, status: 200, payload: OPENAI_OK });
    await expect(
      generateDraftsWithAi({ ...CONFIG, apiKey: '  ' }, { topic: '전세사기', durationSec: 60 }, stub.fetchImpl),
    ).rejects.toThrow(/API 키가 비어 있습니다/);
    expect(stub.calls).toHaveLength(0);
  });

  it('응답에서 제공자별 본문만 꺼낸다', () => {
    expect(extractCompletionText('openai', OPENAI_OK)).toContain('전세사기');
    expect(extractCompletionText('anthropic', ANTHROPIC_OK)).toContain('전세사기');
    expect(extractCompletionText('openai', {})).toBeNull();
    expect(extractCompletionText('anthropic', { content: [] })).toBeNull();
  });
});

describe('키 보관', () => {
  it('이 브라우저(localStorage)에만 저장하고 지울 수 있다', () => {
    const storage = fakeStorage();
    expect(loadAiConfig(storage).apiKey).toBe('');
    expect(saveAiConfig(CONFIG, storage)).toBe(true);
    expect(JSON.parse(storage.dump()[AI_STORAGE_KEY] as string).apiKey).toBe('sk-test-1234');
    expect(loadAiConfig(storage)).toEqual(CONFIG);
    clearAiConfig(storage);
    expect(storage.dump()[AI_STORAGE_KEY]).toBeUndefined();
  });

  it('깨진 저장값은 빈 설정으로 돌려준다', () => {
    const storage = fakeStorage();
    storage.setItem(AI_STORAGE_KEY, '{not-json');
    expect(loadAiConfig(storage)).toEqual({ provider: 'openai', model: 'gpt-4o-mini', apiKey: '' });
  });

  it('저장이 막힌 브라우저에서도 예외를 던지지 않는다', () => {
    const storage = fakeStorage();
    storage.setItem = () => {
      throw new Error('QuotaExceeded');
    };
    expect(saveAiConfig(CONFIG, storage)).toBe(false);
    expect(loadAiConfig(null).model).toBe('gpt-4o-mini');
  });
});
