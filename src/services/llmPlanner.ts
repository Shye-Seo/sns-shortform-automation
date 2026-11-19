import type { CrossChannelPlan, PlanInput } from '../types/plan';
import { applyLlmPlan, buildPlannerPrompt, planCrossChannel, type LlmPayload } from './crossChannelPlanner';

/**
 * Optional Claude pass.
 *
 * The pattern engine always runs first and produces a complete, schema-checked
 * plan. With an API key the same plan is handed to Claude as a structured
 * rewrite request, and only fields that come back valid replace the offline
 * text. Without a key — or when the call fails — the caller keeps the offline
 * plan and reports why, so the console never depends on a network round trip.
 */

const DEFAULT_API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';

export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  },
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

export interface LlmPlanOptions {
  apiKey?: string;
  model?: string;
  apiUrl?: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  maxTokens?: number;
}

export interface LlmPlanResult {
  plan: CrossChannelPlan | null;
  prompt: string;
  model: string;
  error: string | null;
  usage: { inputTokens?: number; outputTokens?: number } | null;
}

const SYSTEM_PROMPT =
  '당신은 한국 2030 타깃의 숏폼·롱폼·블로그를 함께 기획하는 콘텐츠 에디터입니다. 확인되지 않은 수치나 효능을 단정하지 않고, 주어진 채널 패턴의 구조를 지켜 JSON만 출력합니다.';

function extractJson(raw: string): unknown {
  const fenced = raw.replace(/```(?:json)?/gi, '').trim();
  const start = fenced.indexOf('{');
  const end = fenced.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(fenced.slice(start, end + 1));
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Keep only the shape `applyLlmPlan` understands; anything else is dropped. */
export function sanitizePayload(raw: unknown): LlmPayload | null {
  if (!isRecord(raw)) return null;
  const payload: LlmPayload = {};
  let signals = 0;

  if (isRecord(raw.shorts)) {
    const shorts = raw.shorts;
    const scenes = Array.isArray(shorts.scenes)
      ? shorts.scenes
          .filter(isRecord)
          .map((scene) => ({
            narration: typeof scene.narration === 'string' ? scene.narration : undefined,
            onScreenText: typeof scene.onScreenText === 'string' ? scene.onScreenText : undefined,
            beat: typeof scene.beat === 'string' ? scene.beat : undefined,
          }))
          .filter((scene) => scene.narration)
      : [];
    payload.shorts = {
      hook: typeof shorts.hook === 'string' ? shorts.hook : undefined,
      scenes,
      caption: typeof shorts.caption === 'string' ? shorts.caption : undefined,
      hashtags: Array.isArray(shorts.hashtags) ? shorts.hashtags.filter((tag): tag is string => typeof tag === 'string') : undefined,
    };
    if (scenes.length > 0) signals += 1;
  }

  if (isRecord(raw.longform)) {
    const longform = raw.longform;
    const chapters = Array.isArray(longform.chapters)
      ? longform.chapters
          .filter(isRecord)
          .map((chapter) => ({
            title: typeof chapter.title === 'string' ? chapter.title : undefined,
            purpose: typeof chapter.purpose === 'string' ? chapter.purpose : undefined,
            bullets: Array.isArray(chapter.bullets)
              ? chapter.bullets.filter((bullet): bullet is string => typeof bullet === 'string')
              : undefined,
          }))
          .filter((chapter) => chapter.title || chapter.bullets?.length)
      : [];
    payload.longform = {
      title: typeof longform.title === 'string' ? longform.title : undefined,
      coldOpen: typeof longform.coldOpen === 'string' ? longform.coldOpen : undefined,
      chapters,
      cta: typeof longform.cta === 'string' ? longform.cta : undefined,
      thumbnailText: typeof longform.thumbnailText === 'string' ? longform.thumbnailText : undefined,
    };
    if (chapters.length > 0) signals += 1;
  }

  if (isRecord(raw.blog)) {
    const blog = raw.blog;
    const sections = Array.isArray(blog.sections)
      ? blog.sections
          .filter(isRecord)
          .map((section) => ({
            heading: typeof section.heading === 'string' ? section.heading : undefined,
            points: Array.isArray(section.points)
              ? section.points.filter((point): point is string => typeof point === 'string')
              : undefined,
          }))
          .filter((section) => section.heading || section.points?.length)
      : [];
    payload.blog = {
      title: typeof blog.title === 'string' ? blog.title : undefined,
      metaDescription: typeof blog.metaDescription === 'string' ? blog.metaDescription : undefined,
      intro: typeof blog.intro === 'string' ? blog.intro : undefined,
      sections,
      faq: Array.isArray(blog.faq)
        ? blog.faq
            .filter(isRecord)
            .map((entry) => ({
              question: typeof entry.question === 'string' ? entry.question : undefined,
              answer: typeof entry.answer === 'string' ? entry.answer : undefined,
            }))
            .filter((entry) => entry.question && entry.answer)
            .map((entry) => ({ question: entry.question as string, answer: entry.answer as string }))
        : undefined,
      closing: typeof blog.closing === 'string' ? blog.closing : undefined,
      keywords: Array.isArray(blog.keywords) ? blog.keywords.filter((keyword): keyword is string => typeof keyword === 'string') : undefined,
    };
    if (sections.length > 0 || payload.blog.intro) signals += 1;
  }

  return signals > 0 ? payload : null;
}

export async function planWithClaude(input: PlanInput, options: LlmPlanOptions = {}): Promise<LlmPlanResult> {
  const base = planCrossChannel(input);
  const prompt = buildPlannerPrompt(base);
  const model = options.model ?? process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-5';
  const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    return { plan: null, prompt, model, error: 'ANTHROPIC_API_KEY 없음 — 내장 패턴 엔진 결과를 그대로 사용했습니다.', usage: null };
  }

  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike | undefined);
  if (!fetchImpl) {
    return { plan: null, prompt, model, error: 'fetch를 사용할 수 없는 환경입니다.', usage: null };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 90_000);
  try {
    const response = await fetchImpl(options.apiUrl ?? DEFAULT_API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': API_VERSION,
      },
      body: JSON.stringify({
        model,
        max_tokens: options.maxTokens ?? 3000,
        temperature: 0.7,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: controller.signal,
    });

    const text = await response.text();
    if (!response.ok) {
      return { plan: null, prompt, model, error: `Claude HTTP ${response.status}: ${text.slice(0, 240)}`, usage: null };
    }

    const body = JSON.parse(text) as {
      content?: Array<{ type?: string; text?: string }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    const answer = (body.content ?? [])
      .filter((part) => part.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text as string)
      .join('');
    const payload = sanitizePayload(extractJson(answer));
    if (!payload) {
      return { plan: null, prompt, model, error: '응답에서 기대한 JSON 구조를 찾지 못했습니다.', usage: null };
    }

    return {
      plan: applyLlmPlan(base, payload, model),
      prompt,
      model,
      error: null,
      usage: { inputTokens: body.usage?.input_tokens, outputTokens: body.usage?.output_tokens },
    };
  } catch (error) {
    const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    return { plan: null, prompt, model, error: `Claude 호출 실패 — ${reason}`, usage: null };
  } finally {
    clearTimeout(timer);
  }
}
