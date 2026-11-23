/**
 * 서버에서만 쓰는 모델 호출.
 *
 * 키는 서버 환경변수에 있고 브라우저로 나가지 않는다. 응답은 JSON 하나로
 * 받고, 모양이 어긋나면 호출한 쪽이 규칙 기반 결과로 되돌린다. 여기서는
 * "실패하면 던진다"까지만 책임진다.
 */
import type { SonderEnv } from './env';

export type LlmProvider = 'openai' | 'anthropic';

export interface LlmConfig {
  provider: LlmProvider;
  apiKey: string;
  model: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface LlmClient {
  provider: LlmProvider;
  model: string;
  complete(system: string, user: string): Promise<unknown>;
}

/** ```json 울타리나 앞뒤 설명이 붙어 와도 JSON만 꺼낸다. */
export function parseJsonLoose(raw: string): unknown {
  const text = raw.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = fenced?.[1]?.trim() ?? text;
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(candidate.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

export function createLlm(config: LlmConfig): LlmClient {
  const fetchImpl = config.fetchImpl ?? fetch;
  const timeoutMs = config.timeoutMs ?? 20000;

  return {
    provider: config.provider,
    model: config.model,
    async complete(system: string, user: string): Promise<unknown> {
      if (config.provider === 'openai') {
        const response = await fetchImpl('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${config.apiKey}`,
          },
          body: JSON.stringify({
            model: config.model,
            temperature: 0.4,
            response_format: { type: 'json_object' },
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: user },
            ],
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        const body = (await response.json().catch(() => null)) as
          | { choices?: Array<{ message?: { content?: string } }>; error?: { message?: string } }
          | null;
        if (!response.ok) {
          throw new Error(`openai ${response.status}: ${body?.error?.message ?? 'request failed'}`);
        }
        const text = body?.choices?.[0]?.message?.content ?? '';
        return parseJsonLoose(text);
      }

      const response = await fetchImpl('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': config.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: config.model,
          max_tokens: 1600,
          system,
          messages: [{ role: 'user', content: user }],
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const body = (await response.json().catch(() => null)) as
        | { content?: Array<{ type?: string; text?: string }>; error?: { message?: string } }
        | null;
      if (!response.ok) {
        throw new Error(`anthropic ${response.status}: ${body?.error?.message ?? 'request failed'}`);
      }
      const text = (body?.content ?? []).map((part) => part.text ?? '').join('\n');
      return parseJsonLoose(text);
    },
  };
}

/** 설정된 첫 제공자를 쓴다. 없으면 null — 그러면 내장 엔진이 대본을 쓴다. */
export function llmFromEnv(env: SonderEnv, fetchImpl?: typeof fetch): LlmClient | null {
  if (env.openaiKey) {
    return createLlm({ provider: 'openai', apiKey: env.openaiKey, model: env.openaiModel, fetchImpl });
  }
  if (env.anthropicKey) {
    return createLlm({ provider: 'anthropic', apiKey: env.anthropicKey, model: env.anthropicModel, fetchImpl });
  }
  return null;
}
