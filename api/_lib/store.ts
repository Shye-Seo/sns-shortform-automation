/**
 * 저장소 경계.
 *
 * 핸들러는 이 인터페이스만 안다. 배포에서는 Supabase REST 구현이, 단위
 * 테스트에서는 메모리 구현이 들어간다. 두 구현이 같은 계약을 지키는지가
 * 테스트로 확인되는 지점이다.
 */
import type { ChannelIdentity, ContentPlan, PerformanceLog, TrendItem } from '../../src/services/sonder/types';

export interface Store {
  readonly kind: 'memory' | 'supabase';
  listIdentities(): Promise<ChannelIdentity[]>;
  /** id가 있으면 덮어쓰고, 없으면 새로 넣는다. */
  putIdentity(identity: ChannelIdentity): Promise<ChannelIdentity>;
  listTrends(): Promise<TrendItem[]>;
  addTrend(item: TrendItem): Promise<TrendItem>;
  removeTrend(id: string): Promise<boolean>;
  listPlans(): Promise<ContentPlan[]>;
  addPlan(plan: ContentPlan): Promise<ContentPlan>;
  listLogs(): Promise<PerformanceLog[]>;
  addLog(log: PerformanceLog): Promise<PerformanceLog>;
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** 테스트·로컬 API 서버용. 프로세스가 끝나면 사라진다. */
export function createMemoryStore(): Store {
  const identities = new Map<string, ChannelIdentity>();
  const trends = new Map<string, TrendItem>();
  const plans = new Map<string, ContentPlan>();
  const logs = new Map<string, PerformanceLog>();

  const byNewest = <T>(items: T[], key: (item: T) => string): T[] =>
    items.sort((a, b) => key(b).localeCompare(key(a)));

  return {
    kind: 'memory',
    async listIdentities() {
      return byNewest([...identities.values()].map(clone), (item) => item.updatedAt);
    },
    async putIdentity(identity) {
      identities.set(identity.id, clone(identity));
      return clone(identity);
    },
    async listTrends() {
      return byNewest([...trends.values()].map(clone), (item) => item.savedAt);
    },
    async addTrend(item) {
      trends.set(item.id, clone(item));
      return clone(item);
    },
    async removeTrend(id) {
      return trends.delete(id);
    },
    async listPlans() {
      return byNewest([...plans.values()].map(clone), (item) => item.createdAt).slice(0, 40);
    },
    async addPlan(plan) {
      plans.set(plan.id, clone(plan));
      return clone(plan);
    },
    async listLogs() {
      return byNewest([...logs.values()].map(clone), (item) => item.postedAt);
    },
    async addLog(log) {
      logs.set(log.id, clone(log));
      return clone(log);
    },
  };
}
