import { draftsFromModelPayload, parseModelJson, type SceneDraft } from '../../src/services/scriptEngine';
import { buildAiScriptPrompt } from '../../src/services/aiScriptPrompt';
import { classifyScriptDomain } from '../../src/services/scriptDomains';
import { resolveDomainAngle } from '../../src/services/domainScriptWriter';
import type { AngleChoice } from '../../src/types/plan';

/**
 * 선택형 LLM 직접 연결(BYOK).
 *
 * - 키는 이 브라우저의 localStorage에만 저장한다. 이 데모에는 서버가 없고,
 *   어떤 요청도 우리 쪽으로 보내지 않는다. 대화 기록·대본도 저장하지 않는다.
 * - 키가 없으면 내장 도메인 엔진이 대본을 만든다(이 파일을 호출하지 않는다).
 * - OpenAI는 api.openai.com의 chat completions, Anthropic은 messages API를 쓴다.
 *   Anthropic은 브라우저 직접 호출을 허용하는 헤더가 필요하다.
 */

export type AiProvider = 'openai' | 'anthropic';

export interface AiConfig {
  provider: AiProvider;
  model: string;
  apiKey: string;
}

export interface AiDraftResult {
  drafts: SceneDraft[];
  title: string;
  provider: AiProvider;
  model: string;
}

export const AI_STORAGE_KEY = 'shortform.ai.v1';

export const AI_MODELS: Record<AiProvider, string[]> = {
  openai: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini'],
  anthropic: ['claude-sonnet-4-5', 'claude-haiku-4-5', 'claude-3-5-sonnet-latest'],
};

export const AI_PROVIDER_LABEL: Record<AiProvider, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic (Claude)',
};

export const EMPTY_AI_CONFIG: AiConfig = {
  provider: 'openai',
  model: AI_MODELS.openai[0] as string,
  apiKey: '',
};

export class AiScriptError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'AiScriptError';
    this.status = status;
  }
}

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function defaultStorage(): StorageLike | null {
  try {
    return typeof window !== 'undefined' && window.localStorage ? window.localStorage : null;
  } catch {
    // 사생활 보호 모드에서는 localStorage 접근이 예외를 던진다.
    return null;
  }
}

export function loadAiConfig(storage: StorageLike | null = defaultStorage()): AiConfig {
  try {
    const raw = storage?.getItem(AI_STORAGE_KEY);
    if (!raw) return { ...EMPTY_AI_CONFIG };
    const parsed = JSON.parse(raw) as Partial<AiConfig>;
    const provider: AiProvider = parsed.provider === 'anthropic' ? 'anthropic' : 'openai';
    const model =
      typeof parsed.model === 'string' && parsed.model.trim().length > 0
        ? parsed.model.trim()
        : (AI_MODELS[provider][0] as string);
    return { provider, model, apiKey: typeof parsed.apiKey === 'string' ? parsed.apiKey : '' };
  } catch {
    return { ...EMPTY_AI_CONFIG };
  }
}

export function saveAiConfig(config: AiConfig, storage: StorageLike | null = defaultStorage()): boolean {
  try {
    storage?.setItem(AI_STORAGE_KEY, JSON.stringify(config));
    return Boolean(storage);
  } catch {
    return false;
  }
}

export function clearAiConfig(storage: StorageLike | null = defaultStorage()): void {
  try {
    storage?.removeItem(AI_STORAGE_KEY);
  } catch {
    // 저장이 막힌 브라우저는 지울 것도 없다.
  }
}

export interface AiGenerateInput {
  topic: string;
  durationSec: number;
  angle?: AngleChoice;
  ctaGoal?: 'save' | 'comment' | 'follow' | 'link';
}

type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** 제공자별로 응답에서 본문 텍스트만 꺼낸다. */
export function extractCompletionText(provider: AiProvider, payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  if (provider === 'openai') {
    const choices = (payload as { choices?: Array<{ message?: { content?: unknown } }> }).choices;
    const content = choices?.[0]?.message?.content;
    return typeof content === 'string' ? content : null;
  }
  const blocks = (payload as { content?: Array<{ type?: string; text?: unknown }> }).content;
  if (!Array.isArray(blocks)) return null;
  const text = blocks
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('\n')
    .trim();
  return text.length > 0 ? text : null;
}

function errorMessageFor(provider: AiProvider, status: number, detail: string): string {
  if (status === 401 || status === 403) return `${AI_PROVIDER_LABEL[provider]} 키가 거절되었습니다. 키를 다시 확인해 주세요.`;
  if (status === 429) return `${AI_PROVIDER_LABEL[provider]} 요청 한도에 걸렸습니다. 잠시 뒤 다시 시도해 주세요.`;
  if (status >= 500) return `${AI_PROVIDER_LABEL[provider]} 서버가 응답하지 않습니다. 잠시 뒤 다시 시도해 주세요.`;
  return `${AI_PROVIDER_LABEL[provider]} 호출 실패 (${status})${detail ? `: ${detail}` : ''}`;
}

export async function generateDraftsWithAi(
  config: AiConfig,
  input: AiGenerateInput,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<AiDraftResult> {
  if (!config.apiKey.trim()) throw new AiScriptError('API 키가 비어 있습니다.');
  if (input.topic.trim().length < 2) throw new AiScriptError('주제를 두 글자 이상 입력해 주세요.');

  // 앵글이 자동이면 내장 엔진과 같은 기준으로 하나를 고른다(앵글마다 다른 훅).
  const domain = classifyScriptDomain(input.topic);
  const angle = resolveDomainAngle(input.angle ?? 'auto', input.topic, 0);
  const prompt = buildAiScriptPrompt({
    topic: input.topic,
    durationSec: input.durationSec,
    language: 'ko',
    angle,
    ctaGoal: input.ctaGoal ?? 'save',
    domain,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45_000);
  try {
    const request: { url: string; headers: Record<string, string>; body: string } =
      config.provider === 'openai'
        ? {
            url: 'https://api.openai.com/v1/chat/completions',
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer ${config.apiKey.trim()}`,
            },
            body: JSON.stringify({
              model: config.model,
              temperature: 0.8,
              response_format: { type: 'json_object' },
              messages: [
                { role: 'system', content: prompt.system },
                { role: 'user', content: prompt.user },
              ],
            }),
          }
        : {
            url: 'https://api.anthropic.com/v1/messages',
            headers: {
              'content-type': 'application/json',
              'x-api-key': config.apiKey.trim(),
              'anthropic-version': '2023-06-01',
              // 브라우저에서 직접 호출할 때 Anthropic이 요구하는 헤더.
              'anthropic-dangerous-direct-browser-access': 'true',
            },
            body: JSON.stringify({
              model: config.model,
              max_tokens: 2000,
              temperature: 0.8,
              system: prompt.system,
              messages: [{ role: 'user', content: prompt.user }],
            }),
          };

    let response: Awaited<ReturnType<FetchLike>>;
    try {
      response = await fetchImpl(request.url, {
        method: 'POST',
        headers: request.headers,
        body: request.body,
        signal: controller.signal,
      });
    } catch (error) {
      const reason = error instanceof Error && error.name === 'AbortError' ? '시간이 초과되었습니다.' : '네트워크 또는 브라우저 차단(CORS)으로 호출하지 못했습니다.';
      throw new AiScriptError(reason);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new AiScriptError(`${AI_PROVIDER_LABEL[config.provider]} 응답을 읽지 못했습니다.`);
    }

    if (!response.ok) {
      const detail =
        typeof payload === 'object' && payload !== null
          ? String((payload as { error?: { message?: unknown } }).error?.message ?? '')
          : '';
      throw new AiScriptError(errorMessageFor(config.provider, response.status, detail), response.status);
    }

    const text = extractCompletionText(config.provider, payload);
    if (!text) throw new AiScriptError('모델이 빈 응답을 돌려줬습니다.');

    let parsed: { drafts: SceneDraft[]; title?: string };
    try {
      parsed = draftsFromModelPayload(parseModelJson(text));
    } catch (error) {
      throw new AiScriptError(
        `모델 응답이 대본 형식이 아닙니다${error instanceof Error ? `: ${error.message}` : ''}`,
      );
    }

    return {
      drafts: parsed.drafts,
      title: parsed.title ?? input.topic,
      provider: config.provider,
      model: config.model,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** 콘솔 표시용: "OpenAI gpt-4o-mini로 생성". */
export function describeAiResult(result: AiDraftResult): string {
  return `${AI_PROVIDER_LABEL[result.provider]} ${result.model}로 생성`;
}
