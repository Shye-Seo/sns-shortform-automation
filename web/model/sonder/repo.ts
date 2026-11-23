/**
 * 화면이 쓰는 저장소.
 *
 * 두 모드가 같은 인터페이스를 따른다.
 *  - local: 브라우저 localStorage. 정적 페이지(GitHub Pages)에서도 100% 동작한다.
 *  - cloud: /api/* 함수. Supabase가 연결된 배포에서만 켜진다.
 *
 * 모드는 `/api/health`의 database 값 하나로 정한다. 정적 호스트는 이 주소에
 * 404나 HTML을 돌려주므로, 그때는 조용히 로컬로 남는다.
 */
import { IDENTITY_PRESETS, normalizeIdentity } from '../../../src/services/sonder/identity';
import { summarizeLogs, withMultiplier } from '../../../src/services/sonder/performance';
import { buildPlan, type PlanInput, type PlanResult } from '../../../src/services/sonder/planner';
import { analyzeReference, type ReferenceAnalysis, type ReferenceInput } from '../../../src/services/sonder/reference';
import {
  sonderId,
  type ChannelIdentity,
  type ContentPlan,
  type HookPattern,
  type IdentityDraft,
  type PerformanceLog,
  type TrendItem,
} from '../../../src/services/sonder/types';
import { summarizeVault, viralVerdict } from '../../../src/services/sonder/viral';

export type SonderMode = 'checking' | 'local' | 'cloud';

export interface TrendInput {
  url: string;
  title: string;
  transcript: string;
  views: number;
  medianViews: number;
  durationSec?: number;
  author?: string;
  note?: string;
}

export interface NewLogInput {
  planId?: string;
  title: string;
  hookPattern: HookPattern;
  postedAt: string;
  views: number;
  saves: number;
  shares: number;
  follows: number;
  medianViews: number;
}

export interface SonderStore {
  readonly mode: 'local' | 'cloud';
  listIdentities(): Promise<ChannelIdentity[]>;
  saveIdentity(draft: IdentityDraft): Promise<ChannelIdentity>;
  listTrends(): Promise<TrendItem[]>;
  addTrend(input: TrendInput): Promise<TrendItem>;
  removeTrend(id: string): Promise<void>;
  analyze(input: ReferenceInput): Promise<ReferenceAnalysis>;
  listPlans(): Promise<ContentPlan[]>;
  /** `warning`은 모델 호출이 실패해 내장 엔진으로 만들었을 때만 붙는다. */
  generatePlan(input: PlanInput): Promise<PlanResult & { warning?: string }>;
  listLogs(): Promise<PerformanceLog[]>;
  addLog(input: NewLogInput): Promise<PerformanceLog>;
}

/* ── 로컬 모드 ─────────────────────────────────────────────────────────────── */

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const KEY = {
  identity: 'shortform.sonder.identity.v1',
  trends: 'shortform.sonder.trends.v1',
  plans: 'shortform.sonder.plans.v1',
  logs: 'shortform.sonder.logs.v1',
} as const;

function browserStorage(): StorageLike | null {
  try {
    return typeof window !== 'undefined' && window.localStorage ? window.localStorage : null;
  } catch {
    // 사생활 보호 모드에서는 localStorage 접근이 예외를 던진다.
    return null;
  }
}

/** localStorage가 막힌 브라우저에서도 이번 세션 동안은 동작하게 하는 대체 저장소. */
function memoryStorage(): StorageLike {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
  };
}

function readJson<T>(storage: StorageLike, key: string, fallback: T): T {
  try {
    const raw = storage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeJson(storage: StorageLike, key: string, value: unknown): void {
  try {
    storage.setItem(key, JSON.stringify(value));
  } catch {
    // 용량 초과·차단은 조용히 넘긴다. 화면은 방금 만든 값을 계속 들고 있다.
  }
}

export function createLocalStore(storage: StorageLike | null = browserStorage()): SonderStore {
  const box = storage ?? memoryStorage();

  const identities = (): ChannelIdentity[] => {
    const stored = readJson<ChannelIdentity[] | null>(box, KEY.identity, null);
    if (stored && Array.isArray(stored) && stored.length > 0) return stored;
    writeJson(box, KEY.identity, IDENTITY_PRESETS);
    return [...IDENTITY_PRESETS];
  };
  const trends = (): TrendItem[] => readJson<TrendItem[]>(box, KEY.trends, []);
  const plans = (): ContentPlan[] => readJson<ContentPlan[]>(box, KEY.plans, []);
  const logs = (): PerformanceLog[] => readJson<PerformanceLog[]>(box, KEY.logs, []);

  return {
    mode: 'local',
    async listIdentities() {
      return identities();
    },
    async saveIdentity(draft) {
      const identity = normalizeIdentity(draft);
      const list = identities();
      const index = list.findIndex((item) => item.id === identity.id);
      const next = [...list];
      if (index >= 0) next[index] = identity;
      else next.push(identity);
      writeJson(box, KEY.identity, next);
      return identity;
    },
    async listTrends() {
      return trends();
    },
    async addTrend(input) {
      const analysis = analyzeReference({
        url: input.url,
        title: input.title || undefined,
        transcript: input.transcript || undefined,
        durationSec: input.durationSec,
        author: input.author,
      });
      const verdict = viralVerdict(input.views, input.medianViews);
      const item: TrendItem = {
        id: sonderId('trend'),
        url: input.url.trim(),
        title: analysis.title,
        author: analysis.author,
        transcript: input.transcript,
        views: Math.max(0, Math.round(input.views)),
        medianViews: Math.max(0, Math.round(input.medianViews)),
        multiplier: verdict.multiplier,
        level: verdict.level,
        structure: analysis.structure,
        note: input.note ?? '',
        savedAt: new Date().toISOString(),
      };
      writeJson(box, KEY.trends, [item, ...trends()].slice(0, 100));
      return item;
    },
    async removeTrend(id) {
      writeJson(box, KEY.trends, trends().filter((item) => item.id !== id));
    },
    async analyze(input) {
      return analyzeReference(input);
    },
    async listPlans() {
      return plans();
    },
    async generatePlan(input) {
      const result = buildPlan({ ...input, feedback: summarizeLogs(logs()) });
      // 같은 주제·구조·채널이면 훅을 바꿔 다시 만든 것이다. 새 행을 쌓지 않고
      // 그 기획안을 고친 것으로 본다.
      const existing = plans().find(
        (plan) =>
          plan.topic === result.plan.topic &&
          plan.trendId === result.plan.trendId &&
          plan.identityId === result.plan.identityId,
      );
      const plan = existing ? { ...result.plan, id: existing.id, createdAt: existing.createdAt } : result.plan;
      const next = [plan, ...plans().filter((item) => item.id !== plan.id)].slice(0, 40);
      writeJson(box, KEY.plans, next);
      return { ...result, plan };
    },
    async listLogs() {
      return logs();
    },
    async addLog(input) {
      const log = withMultiplier({
        id: sonderId('log'),
        planId: input.planId ?? null,
        title: input.title,
        hookPattern: input.hookPattern,
        postedAt: input.postedAt,
        views: Math.max(0, Math.round(input.views)),
        saves: Math.max(0, Math.round(input.saves)),
        shares: Math.max(0, Math.round(input.shares)),
        follows: Math.max(0, Math.round(input.follows)),
        medianViews: Math.max(0, Math.round(input.medianViews)),
        createdAt: new Date().toISOString(),
      });
      writeJson(box, KEY.logs, [log, ...logs()].slice(0, 300));
      return log;
    },
  };
}

/** 보관함 요약은 화면이 목록에서 바로 계산한다. 저장하지 않는다. */
export const vaultSummary = summarizeVault;

/* ── 클라우드 모드 ─────────────────────────────────────────────────────────── */

interface ApiErrorBody {
  error?: string;
  code?: string;
}

async function callApi<T>(path: string, init: RequestInit = {}, fetchImpl: typeof fetch = fetch): Promise<T> {
  const response = await fetchImpl(path, {
    ...init,
    headers: { 'content-type': 'application/json', accept: 'application/json', ...(init.headers ?? {}) },
    cache: 'no-store',
  });
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!response.ok) {
    const message = (body as ApiErrorBody | null)?.error ?? `요청을 처리하지 못했습니다 (${response.status})`;
    throw new Error(message);
  }
  return body as T;
}

export function createCloudStore(fetchImpl: typeof fetch = fetch): SonderStore {
  const json = <T,>(path: string, init?: RequestInit): Promise<T> => callApi<T>(path, init ?? {}, fetchImpl);

  return {
    mode: 'cloud',
    async listIdentities() {
      const body = await json<{ items: ChannelIdentity[] }>('/api/channel-identity');
      return body.items ?? [];
    },
    async saveIdentity(draft) {
      const method = draft.id ? 'PUT' : 'POST';
      const body = await json<{ item: ChannelIdentity }>('/api/channel-identity', {
        method,
        body: JSON.stringify(draft),
      });
      return body.item;
    },
    async listTrends() {
      const body = await json<{ items: TrendItem[] }>('/api/trend-vault');
      return body.items ?? [];
    },
    async addTrend(input) {
      const body = await json<{ item: TrendItem }>('/api/trend-vault', {
        method: 'POST',
        body: JSON.stringify(input),
      });
      return body.item;
    },
    async removeTrend(id) {
      await json(`/api/trend-vault?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
    },
    async analyze(input) {
      const body = await json<{ structure: ReferenceAnalysis['structure']; title: string; author: string; platform: ReferenceAnalysis['platform'] }>(
        '/api/analyze-reference',
        { method: 'POST', body: JSON.stringify(input) },
      );
      return { structure: body.structure, title: body.title, author: body.author, platform: body.platform };
    },
    async listPlans() {
      const body = await json<{ items: ContentPlan[] }>('/api/generate-plan');
      return body.items ?? [];
    },
    async generatePlan(input) {
      const body = await json<{
        plan: ContentPlan;
        recommended: PlanResult['recommended'];
        warning?: string;
      }>('/api/generate-plan', {
        method: 'POST',
        body: JSON.stringify({
          topic: input.topic,
          identityId: input.identity.id,
          identity: input.identity,
          structure: input.structure,
          trendId: input.trendId,
          trendTitle: input.trendTitle,
          durationSec: input.durationSec,
          goal: input.goal,
          chosenHook: input.chosenHook,
        }),
      });
      return { plan: body.plan, recommended: body.recommended, warning: body.warning };
    },
    async listLogs() {
      const body = await json<{ items: PerformanceLog[] }>('/api/performance-logs');
      return body.items ?? [];
    },
    async addLog(input) {
      const body = await json<{ item: PerformanceLog }>('/api/performance-logs', {
        method: 'POST',
        body: JSON.stringify(input),
      });
      return body.item;
    },
  };
}

/* ── 모드 판별 ─────────────────────────────────────────────────────────────── */

export interface ResolvedStore {
  mode: 'local' | 'cloud';
  store: SonderStore;
}

async function probeCloud(fetchImpl?: typeof fetch): Promise<boolean> {
  const doFetch = fetchImpl ?? (typeof fetch === 'function' ? fetch : undefined);
  if (!doFetch) return false;
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = setTimeout(() => controller?.abort(), 2500);
  try {
    const response = await doFetch('/api/health', {
      headers: { accept: 'application/json' },
      cache: 'no-store',
      signal: controller?.signal,
    });
    const type = response.headers?.get?.('content-type') ?? '';
    if (!response.ok || !type.includes('application/json')) return false;
    const body = (await response.json()) as { database?: string };
    return body?.database === 'connected';
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

let resolved: ResolvedStore | null = null;

/** 앱이 한 번만 부른다. 같은 탭에서 다시 판별하지 않는다. */
export async function resolveStore(force = false, fetchImpl?: typeof fetch): Promise<ResolvedStore> {
  if (resolved && !force) return resolved;
  const cloud = await probeCloud(fetchImpl);
  resolved = cloud
    ? { mode: 'cloud', store: createCloudStore(fetchImpl ?? fetch) }
    : { mode: 'local', store: createLocalStore() };
  return resolved;
}

/** 테스트가 모드 판별 결과를 되돌릴 때. */
export function resetStoreResolution(): void {
  resolved = null;
}
