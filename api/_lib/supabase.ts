/**
 * Supabase REST 구현.
 *
 * supabase-js를 넣지 않고 PostgREST를 직접 부른다. 서버 함수 번들이 작고,
 * 여기서 쓰는 것은 select·insert(upsert)·delete 네 가지뿐이라 의존성을 하나
 * 줄이는 편이 낫다. 서비스 롤 키는 서버 환경변수에만 있고 브라우저로 나가지
 * 않는다.
 */
import type { ChannelIdentity, ContentPlan, PerformanceLog, TrendItem } from '../../src/services/sonder/types';
import type { Store } from './store';

export interface SupabaseConfig {
  url: string;
  serviceKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

type Row = Record<string, unknown>;

const str = (value: unknown, fallback = ''): string => (typeof value === 'string' ? value : fallback);
const num = (value: unknown, fallback = 0): number => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
};
const nullableNum = (value: unknown): number | null => (value === null || value === undefined ? null : num(value, 0));

function jsonArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item));
  return [];
}

export function identityFromRow(row: Row): ChannelIdentity {
  return {
    id: str(row.id),
    name: str(row.name),
    handle: str(row.handle),
    posture: str(row.posture),
    audience: str(row.audience),
    voice: str(row.voice),
    strengths: jsonArray(row.strengths),
    banned: jsonArray(row.banned),
    signature: jsonArray(row.signature),
    updatedAt: str(row.updated_at, new Date(0).toISOString()),
  };
}

export function identityToRow(identity: ChannelIdentity): Row {
  return {
    id: identity.id,
    name: identity.name,
    handle: identity.handle,
    posture: identity.posture,
    audience: identity.audience,
    voice: identity.voice,
    strengths: identity.strengths,
    banned: identity.banned,
    signature: identity.signature,
    updated_at: identity.updatedAt,
  };
}

export function trendFromRow(row: Row): TrendItem {
  return {
    id: str(row.id),
    url: str(row.url),
    title: str(row.title),
    author: str(row.author),
    transcript: str(row.transcript),
    views: num(row.views),
    medianViews: num(row.median_views),
    multiplier: nullableNum(row.multiplier),
    level: str(row.level, 'unknown') as TrendItem['level'],
    structure: (row.structure ?? {}) as TrendItem['structure'],
    note: str(row.note),
    savedAt: str(row.saved_at, new Date(0).toISOString()),
  };
}

export function trendToRow(item: TrendItem): Row {
  return {
    id: item.id,
    url: item.url,
    title: item.title,
    author: item.author,
    transcript: item.transcript,
    views: item.views,
    median_views: item.medianViews,
    multiplier: item.multiplier,
    level: item.level,
    structure: item.structure,
    note: item.note,
    saved_at: item.savedAt,
  };
}

export function planFromRow(row: Row): ContentPlan {
  const plan = row.plan;
  if (typeof plan === 'object' && plan !== null) return plan as ContentPlan;
  // plan 컬럼이 비어 있는 옛 행은 핵심 열로 되살린다.
  return {
    id: str(row.id),
    topic: str(row.topic),
    identityId: str(row.identity_id),
    identityName: str(row.identity_name),
    trendId: str(row.trend_id) || null,
    trendTitle: str(row.trend_title),
    goal: str(row.goal, 'save') as ContentPlan['goal'],
    structure: { beats: [], transitions: [], signals: [], basis: [] } as unknown as ContentPlan['structure'],
    hooks: [],
    chosenHook: str(row.chosen_hook, 'A') as ContentPlan['chosenHook'],
    scenes: [],
    beatTable: [],
    caption: '',
    hashtags: [],
    checks: { bannedHits: [], hookSec: 0, totalSec: 0, rhythmNotes: [] },
    notes: [],
    source: 'rules',
    createdAt: str(row.created_at, new Date(0).toISOString()),
  };
}

export function planToRow(plan: ContentPlan): Row {
  return {
    id: plan.id,
    topic: plan.topic,
    identity_id: plan.identityId || null,
    identity_name: plan.identityName,
    trend_id: plan.trendId,
    trend_title: plan.trendTitle,
    goal: plan.goal,
    chosen_hook: plan.chosenHook,
    source: plan.source,
    total_sec: plan.checks.totalSec,
    plan,
    created_at: plan.createdAt,
  };
}

export function logFromRow(row: Row): PerformanceLog {
  return {
    id: str(row.id),
    planId: str(row.plan_id) || null,
    title: str(row.title),
    hookPattern: str(row.hook_pattern, 'story') as PerformanceLog['hookPattern'],
    postedAt: str(row.posted_at, ''),
    views: num(row.views),
    saves: num(row.saves),
    shares: num(row.shares),
    follows: num(row.follows),
    medianViews: num(row.median_views),
    multiplier: nullableNum(row.multiplier),
    createdAt: str(row.created_at, new Date().toISOString()),
  };
}

export function logToRow(log: PerformanceLog): Row {
  return {
    id: log.id,
    plan_id: log.planId,
    title: log.title,
    hook_pattern: log.hookPattern,
    posted_at: log.postedAt,
    views: log.views,
    saves: log.saves,
    shares: log.shares,
    follows: log.follows,
    median_views: log.medianViews,
    multiplier: log.multiplier,
    created_at: log.createdAt,
  };
}

export function createSupabaseStore(config: SupabaseConfig): Store {
  const base = config.url.replace(/\/+$/, '');
  const fetchImpl = config.fetchImpl ?? fetch;
  const timeoutMs = config.timeoutMs ?? 8000;

  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetchImpl(`${base}/rest/v1/${path}`, {
      ...init,
      headers: {
        apikey: config.serviceKey,
        authorization: `Bearer ${config.serviceKey}`,
        'content-type': 'application/json',
        accept: 'application/json',
        ...(init.headers ?? {}),
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`supabase ${response.status}: ${text.slice(0, 240)}`);
    }
    if (text.trim() === '') return undefined as T;
    return JSON.parse(text) as T;
  }

  return {
    kind: 'supabase',
    async listIdentities() {
      const rows = await request<Row[]>('channel_identities?select=*&order=updated_at.desc&limit=50');
      return (rows ?? []).map(identityFromRow);
    },
    async putIdentity(identity) {
      const rows = await request<Row[]>('channel_identities?on_conflict=id', {
        method: 'POST',
        headers: { prefer: 'resolution=merge-duplicates,return=representation' },
        body: JSON.stringify(identityToRow(identity)),
      });
      return rows?.[0] ? identityFromRow(rows[0]) : identity;
    },
    async listTrends() {
      const rows = await request<Row[]>('trend_vault_items?select=*&order=saved_at.desc&limit=100');
      return (rows ?? []).map(trendFromRow);
    },
    async addTrend(item) {
      const rows = await request<Row[]>('trend_vault_items', {
        method: 'POST',
        headers: { prefer: 'return=representation' },
        body: JSON.stringify(trendToRow(item)),
      });
      return rows?.[0] ? trendFromRow(rows[0]) : item;
    },
    async removeTrend(id) {
      const rows = await request<Row[]>(`trend_vault_items?id=eq.${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers: { prefer: 'return=representation' },
      });
      return Array.isArray(rows) && rows.length > 0;
    },
    async listPlans() {
      const rows = await request<Row[]>('content_plans?select=*&order=created_at.desc&limit=40');
      return (rows ?? []).map(planFromRow);
    },
    async addPlan(plan) {
      const rows = await request<Row[]>('content_plans?on_conflict=id', {
        method: 'POST',
        headers: { prefer: 'resolution=merge-duplicates,return=representation' },
        body: JSON.stringify(planToRow(plan)),
      });
      return rows?.[0] ? planFromRow(rows[0]) : plan;
    },
    async listLogs() {
      const rows = await request<Row[]>('performance_logs?select=*&order=posted_at.desc&limit=200');
      return (rows ?? []).map(logFromRow);
    },
    async addLog(log) {
      const rows = await request<Row[]>('performance_logs', {
        method: 'POST',
        headers: { prefer: 'return=representation' },
        body: JSON.stringify(logToRow(log)),
      });
      return rows?.[0] ? logFromRow(rows[0]) : log;
    },
  };
}
