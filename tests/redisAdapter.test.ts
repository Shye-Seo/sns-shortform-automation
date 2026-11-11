import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  JOB_STATES,
  RedisQueueStore,
  createQueueStore,
  isReservableStore,
  redisQueueKeys,
  resolveQueueDriver,
  type RedisCommand,
  type RedisTransactionClient,
} from '../src/queue/redisAdapter';
import { JobQueue } from '../src/lib/queue/jobQueue';
import { FileQueueStore } from '../src/lib/queue/fileStore';
import { InMemoryQueueStore } from '../src/lib/queue/jobQueue';
import { QueueJobSchema, type QueueJob } from '../src/types/queue';

/**
 * 가짜 Redis — 테스트가 검증하려는 것은 "어댑터가 Redis 트랜잭션을 올바르게 쓰는가"다.
 * 그래서 여기에는 **Redis의 의미**만 구현한다: 해시·집합·정렬집합, 그리고 WATCH가 지켜본 키의
 * 버전이 바뀌면 MULTI를 취소하는 규칙. 어댑터의 Lua/스크립트를 흉내 내지 않는다(그러면 테스트가
 * 구현을 그대로 베끼는 셈이 된다).
 */
class FakeRedisServer {
  readonly hashes = new Map<string, Map<string, string>>();
  readonly sets = new Map<string, Set<string>>();
  readonly zsets = new Map<string, Map<string, number>>();
  readonly versions = new Map<string, number>();

  version(key: string): number {
    return this.versions.get(key) ?? 0;
  }

  private touch(...keys: string[]): void {
    for (const key of keys) this.versions.set(key, this.version(key) + 1);
  }

  apply(command: RedisCommand): unknown {
    const [name, ...args] = command;
    const verb = String(name).toUpperCase();
    const key = String(args[0] ?? '');

    switch (verb) {
      case 'HGET': {
        const value = this.hashes.get(key)?.get(String(args[1]));
        return value ?? null;
      }
      case 'HSET_PLACEHOLDER':
        return null;
      case 'HSET': {
        const hash = this.hashes.get(key) ?? new Map<string, string>();
        const existed = hash.has(String(args[1]));
        hash.set(String(args[1]), String(args[2]));
        this.hashes.set(key, hash);
        this.touch(key);
        return existed ? 0 : 1;
      }
      case 'HDEL': {
        const hash = this.hashes.get(key);
        let removed = 0;
        for (const field of args.slice(1)) if (hash?.delete(String(field))) removed += 1;
        this.touch(key);
        return removed;
      }
      case 'HGETALL': {
        const hash = this.hashes.get(key) ?? new Map<string, string>();
        const flat: string[] = [];
        for (const [field, value] of hash) flat.push(field, value);
        return flat;
      }
      case 'SADD': {
        const set = this.sets.get(key) ?? new Set<string>();
        const before = set.size;
        for (const member of args.slice(1)) set.add(String(member));
        this.sets.set(key, set);
        this.touch(key);
        return set.size - before;
      }
      case 'SREM': {
        const set = this.sets.get(key);
        let removed = 0;
        for (const member of args.slice(1)) if (set?.delete(String(member))) removed += 1;
        this.touch(key);
        return removed;
      }
      case 'SCARD':
        return this.sets.get(key)?.size ?? 0;
      case 'SMEMBERS':
        return [...(this.sets.get(key) ?? new Set<string>())];
      case 'ZADD': {
        const zset = this.zsets.get(key) ?? new Map<string, number>();
        const score = Number(args[1]);
        zset.set(String(args[2]), score);
        this.zsets.set(key, zset);
        this.touch(key);
        return 1;
      }
      case 'ZREM': {
        const zset = this.zsets.get(key);
        let removed = 0;
        for (const member of args.slice(1)) if (zset?.delete(String(member))) removed += 1;
        this.touch(key);
        return removed;
      }
      case 'ZSCORE': {
        const score = this.zsets.get(key)?.get(String(args[1]));
        return score === undefined ? null : String(score);
      }
      case 'ZRANGEBYSCORE': {
        const zset = this.zsets.get(key) ?? new Map<string, number>();
        const min = args[0] === undefined ? '-inf' : String(args[1]);
        const max = String(args[2]);
        const limitIndex = args.findIndex((value) => String(value).toUpperCase() === 'LIMIT');
        const offset = limitIndex >= 0 ? Number(args[limitIndex + 1] ?? 0) : 0;
        const count = limitIndex >= 0 ? Number(args[limitIndex + 2] ?? Number.MAX_SAFE_INTEGER) : Number.MAX_SAFE_INTEGER;
        const lower = min === '-inf' ? Number.NEGATIVE_INFINITY : Number(min);
        const upper = max === '+inf' ? Number.POSITIVE_INFINITY : Number(max);
        const matched = [...zset.entries()]
          .filter(([, score]) => score >= lower && score <= upper)
          .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
          .map(([member]) => member);
        return matched.slice(offset, offset + count);
      }
      case 'DEL': {
        let removed = 0;
        for (const target of [key, ...args.slice(1).map(String)]) {
          if (this.hashes.delete(target) || this.sets.delete(target) || this.zsets.delete(target)) removed += 1;
          this.touch(target);
        }
        return removed;
      }
      default:
        throw new Error(`fake redis: unsupported command ${verb}`);
    }
  }
}

class FakeRedisClient implements RedisTransactionClient {
  private watched = new Map<string, number>();

  constructor(private readonly server: FakeRedisServer, readonly label = 'client') {}

  get setCount(): number {
    return this.server.sets.get(redisQueueKeys().ready)?.size ?? 0;
  }

  async send(commands: RedisCommand[]): Promise<unknown[]> {
    return commands.map((command) => this.server.apply(command));
  }

  async watch(keys: string[]): Promise<void> {
    this.watched = new Map(keys.map((key) => [key, this.server.version(key)]));
  }

  async multi(commands: RedisCommand[]): Promise<unknown[] | null> {
    for (const [key, version] of this.watched) {
      if (this.server.version(key) !== version) {
        this.watched.clear();
        return null;
      }
    }
    const output = commands.map((command) => this.server.apply(command));
    this.watched.clear();
    return output;
  }

  async unwatch(): Promise<void> {
    this.watched.clear();
  }
}

const NOW = Date.parse('2026-11-11T03:00:00.000Z');

function setup(options: { prefix?: string; retry?: Record<string, number> } = {}): {
  server: FakeRedisServer;
  client: FakeRedisClient;
  store: RedisQueueStore;
  other: FakeRedisClient;
} {
  const server = new FakeRedisServer();
  const client = new FakeRedisClient(server, 'worker-a');
  const other = new FakeRedisClient(server, 'worker-b');
  const store = new RedisQueueStore({
    client,
    prefix: options.prefix,
    now: () => NOW,
    random: () => 0,
    retry: { baseDelayMs: 1_000, maxDelayMs: 8_000, jitterRatio: 0, maxAttempts: 3, ...options.retry },
  });
  return { server, client, store, other };
}

/** 같은 가짜 서버에 붙은 별도 노드(연결) */
function storeOn(server: FakeRedisServer, prefix?: string): { store: RedisQueueStore; client: FakeRedisClient } {
  const client = new FakeRedisClient(server);
  return { store: new RedisQueueStore({ client, prefix, now: () => NOW, random: () => 0 }), client };
}

function job(overrides: Partial<QueueJob> = {}): QueueJob {
  return QueueJobSchema.parse({
    id: 'job_1',
    tenantId: 'tn-1',
    name: 'render kitchen reel',
    kind: 'render',
    state: 'waiting',
    priority: 5,
    payload: { projectId: 'p1' },
    attempts: 0,
    maxAttempts: 3,
    progress: 0,
    createdAt: new Date(NOW).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
    availableAt: new Date(NOW).toISOString(),
    ...overrides,
  });
}

describe('RedisQueueStore · QueueStore 계약', () => {
  it('put/get/all/delete가 원본 JSON을 그대로 왕복한다', async () => {
    const { store } = setup();
    const first = job({ id: 'job_1' });
    const second = job({ id: 'job_2', state: 'completed', finishedAt: new Date(NOW).toISOString() });

    await store.put(first);
    await store.put(second);

    expect(await store.get('job_1')).toEqual(first);
    expect((await store.all()).map((item) => item.id).sort()).toEqual(['job_1', 'job_2']);

    await store.delete('job_1');
    expect(await store.get('job_1')).toBeUndefined();
    expect((await store.all()).map((item) => item.id)).toEqual(['job_2']);
  });

  it('상태가 바뀌면 ready/delayed/lease 인덱스와 상태 집합이 함께 움직인다', async () => {
    const { store, server } = setup();
    const keys = redisQueueKeys();

    await store.put(job({ id: 'job_1' }));
    expect(server.zsets.get(keys.ready)?.has('job_1')).toBe(true);
    expect(server.sets.get(keys.state('waiting'))?.has('job_1')).toBe(true);

    await store.put(job({ id: 'job_1', state: 'delayed', availableAt: new Date(NOW + 5_000).toISOString() }));
    expect(server.zsets.get(keys.ready)?.has('job_1')).toBe(false);
    expect(server.zsets.get(keys.delayed)?.get('job_1')).toBe(NOW + 5_000);
    expect(server.sets.get(keys.state('waiting'))?.has('job_1')).toBe(false);
    expect(server.sets.get(keys.state('delayed'))?.has('job_1')).toBe(true);

    await store.put(job({ id: 'job_1', state: 'active', leaseExpiresAt: new Date(NOW + 30_000).toISOString() }));
    expect(server.zsets.get(keys.lease)?.get('job_1')).toBe(NOW + 30_000);
    expect(server.sets.get(keys.state('delayed'))?.has('job_1')).toBe(false);
    expect(server.sets.get(keys.state('active'))?.has('job_1')).toBe(true);
  });

  it('손상된 JSON은 목록에서 조용히 제외한다', async () => {
    const { store, server } = setup();
    server.hashes.set(redisQueueKeys().jobs, new Map([['bad', '{not-json']]));
    await store.put(job({ id: 'job_ok' }));
    expect((await store.all()).map((item) => item.id)).toEqual(['job_ok']);
  });

  it('clear는 자기 prefix의 키만 지운다', async () => {
    const { store, server } = setup({ prefix: 'a' });
    const neighbour = new RedisQueueStore({ client: new FakeRedisClient(server), prefix: 'b', now: () => NOW });
    await store.put(job({ id: 'job_a' }));
    await neighbour.put(job({ id: 'job_b' }));

    await store.clear();
    expect(await store.get('job_a')).toBeUndefined();
    expect((await neighbour.all()).map((item) => item.id)).toEqual(['job_b']);
  });
});

describe('RedisQueueStore · 원자적 선점', () => {
  it('선점하면 active·attempts+1·임대가 한 번에 기록된다', async () => {
    const { store, server } = setup();
    await store.put(job({ id: 'job_1' }));

    const claimed = await store.reserve('worker-a');
    expect(claimed).toMatchObject({ id: 'job_1', state: 'active', attempts: 1, workerId: 'worker-a' });
    expect(claimed?.leaseExpiresAt).toBe(new Date(NOW + 30_000).toISOString());
    expect(claimed?.transitions.at(-1)).toMatchObject({ from: 'waiting', to: 'active' });
    expect(server.zsets.get(redisQueueKeys().ready)?.has('job_1')).toBe(false);
    expect(await store.get('job_1')).toMatchObject({ state: 'active', attempts: 1 });
  });

  it('가져갈 작업이 없으면 null을 돌려준다', async () => {
    const { store } = setup();
    expect(await store.reserve('worker-a')).toBeNull();
  });

  it('여러 워커가 동시에 선점해도 같은 작업을 두 번 주지 않는다', async () => {
    const { store } = setup();
    for (let index = 0; index < 5; index += 1) await store.put(job({ id: `job_${index}` }));

    // 한 프로세스 안에서 동시에 들어온 선점 요청: 연결 하나를 공유하므로 어댑터가 직렬화한다
    const claims = await Promise.all(Array.from({ length: 12 }, (_, worker) => store.reserve(`worker-${worker}`)));
    const ids = claims.filter((item): item is QueueJob => Boolean(item)).map((item) => item.id);

    expect(ids).toHaveLength(5);
    expect(new Set(ids).size).toBe(5);
  });

  it('노드 6대가 같은 백로그를 동시에 노려도 중복 선점이 없다', async () => {
    const server = new FakeRedisServer();
    const seed = storeOn(server).store;
    for (let index = 0; index < 8; index += 1) await seed.put(job({ id: `job_${index}` }));

    const nodes = Array.from({ length: 6 }, () => storeOn(server).store);
    const claims = await Promise.all(
      nodes.map(async (node) => {
        const claimed: string[] = [];
        for (;;) {
          const next = await node.reserve('node-x');
          if (!next) break;
          claimed.push(next.id);
        }
        return claimed;
      }),
    );
    const ids = claims.flat();
    expect(ids).toHaveLength(8);
    expect(new Set(ids).size).toBe(8);
  });

  it('WATCH 충돌이 나면 EXEC가 취소되고, 다시 골라 다른 작업을 가져간다', async () => {
    const { store, server, client } = setup();
    const other = storeOn(server).client;
    await store.put(job({ id: 'job_1' }));
    await store.put(job({ id: 'job_2' }));
    const keys = redisQueueKeys();

    // 두 클라이언트가 같은 후보를 본 상태를 만든다(경합의 순간을 수동으로 재현).
    await client.watch([keys.ready, keys.jobs]);
    await other.watch([keys.ready, keys.jobs]);
    const [candidatesA] = await client.send([['ZRANGEBYSCORE', keys.ready, '-inf', NOW, 'LIMIT', 0, 1]]);
    const [candidatesB] = await other.send([['ZRANGEBYSCORE', keys.ready, '-inf', NOW, 'LIMIT', 0, 1]]);
    expect(candidatesA).toEqual(candidatesB);

    const winner = await client.multi([['ZREM', keys.ready, 'job_1']]);
    const loser = await other.multi([['ZREM', keys.ready, 'job_1']]);
    expect(winner).not.toBeNull();
    expect(loser).toBeNull(); // 먼저 간 쪽이 이겼고, 진 쪽은 아무것도 쓰지 않았다

    const claimed = await storeOn(server).store.reserve('worker-b');
    expect(claimed?.id).toBe('job_2');
    expect(server.zsets.get(keys.ready)?.size).toBe(0);
  });

  it('유령 인덱스(작업 없음/대기 아님)는 건너뛰고 스스로 고친다', async () => {
    const { store, server } = setup();
    const keys = redisQueueKeys();
    await store.put(job({ id: 'job_ok' }));
    await store.put(job({ id: 'job_done', state: 'completed', finishedAt: new Date(NOW).toISOString() }));
    // 완료된 작업의 id를 ready에 다시 넣어 인덱스가 어긋난 상태를 만든다
    server.zsets.get(keys.ready)?.set('job_done', NOW - 10);

    const claimed = await store.reserve('worker-a');
    expect(claimed?.id).toBe('job_ok');
    expect(server.zsets.get(keys.ready)?.has('job_done')).toBe(false);
  });

  it('아직 때가 아닌데 ready에 있는 작업은 delayed로 되돌린다', async () => {
    const { store, server } = setup();
    const keys = redisQueueKeys();
    await store.put(job({ id: 'job_future', availableAt: new Date(NOW + 60_000).toISOString() }));
    server.zsets.get(keys.delayed)?.delete('job_future');
    server.zsets.get(keys.ready)?.set('job_future', NOW - 1); // 잘못 끼어든 인덱스

    const claimed = await store.reserve('worker-a');
    expect(claimed).toBeNull();
    expect((await store.get('job_future'))?.state).toBe('delayed');
  });
});

describe('RedisQueueStore · 지연 작업', () => {
  it('때가 된 delayed만 waiting으로 승격한다', async () => {
    const { store, server } = setup();
    const keys = redisQueueKeys();
    await store.put(job({ id: 'job_due', state: 'delayed', availableAt: new Date(NOW - 1_000).toISOString() }));
    await store.put(job({ id: 'job_wait', state: 'delayed', availableAt: new Date(NOW + 60_000).toISOString() }));

    const promoted = await store.promoteDelayed(NOW);
    expect(promoted).toBe(1);
    expect((await store.get('job_due'))?.state).toBe('waiting');
    expect((await store.get('job_wait'))?.state).toBe('delayed');
    expect(server.zsets.get(keys.ready)?.has('job_due')).toBe(true);
    expect(server.zsets.get(keys.delayed)?.has('job_due')).toBe(false);

    // 승격된 작업은 즉시 선점할 수 있다
    expect((await store.reserve('worker-a'))?.id).toBe('job_due');
  });

  it('승격 중 유령 항목은 인덱스에서 제거한다', async () => {
    const { store, server } = setup();
    const keys = redisQueueKeys();
    server.zsets.set(keys.delayed, new Map([['ghost', NOW - 5]]));
    expect(await store.promoteDelayed(NOW)).toBe(0);
    expect(server.zsets.get(keys.delayed)?.has('ghost')).toBe(false);
  });
});

describe('RedisQueueStore · 생명주기', () => {
  it('heartbeat는 소유자만 임대를 연장한다', async () => {
    const { store } = setup();
    await store.put(job({ id: 'job_1' }));
    await store.reserve('worker-a');

    const renewed = await store.heartbeat('job_1', 'worker-a', 60_000, { now: NOW + 10_000 });
    expect(renewed.leaseExpiresAt).toBe(new Date(NOW + 70_000).toISOString());
    await expect(store.heartbeat('job_1', 'worker-b')).rejects.toMatchObject({ code: 'VALIDATION', message: expect.stringContaining('leased by worker-a') });
  });

  it('complete는 완료 상태와 결과를 남기고 임대를 해제한다', async () => {
    const { store, server } = setup();
    await store.put(job({ id: 'job_1' }));
    await store.reserve('worker-a');

    const done = await store.complete('job_1', { outputPath: 'renders/1.mp4' }, { now: NOW + 5_000 });
    expect(done.state).toBe('completed');
    expect(done.progress).toBe(100);
    expect(done.leaseExpiresAt).toBeNull();
    expect(done.result).toEqual({ outputPath: 'renders/1.mp4' });
    expect(server.zsets.get(redisQueueKeys().lease)?.has('job_1')).toBe(false);
  });

  it('재시도 가능한 실패는 백오프 후 delayed로, 소진되면 dlq로 보낸다', async () => {
    const { store } = setup();
    await store.put(job({ id: 'job_1' }));
    await store.reserve('worker-a');

    const first = await store.fail('job_1', new Error('ffmpeg crashed'), { now: NOW });
    expect(first.willRetry).toBe(true);
    expect(first.job.state).toBe('delayed');
    expect(first.job.availableAt).toBe(new Date(NOW + 1_000).toISOString()); // attempts 1 → 1s
    expect(first.job.lastError).toBe('ffmpeg crashed');
    expect(first.job.workerId).toBeNull();

    // 두 번째 시도: attempts 2 → 2s
    await store.put({ ...first.job, state: 'waiting', availableAt: new Date(NOW).toISOString() });
    await store.reserve('worker-a');
    const second = await store.fail('job_1', new Error('ffmpeg crashed again'), { now: NOW + 1_000 });
    expect(second.job.state).toBe('delayed');
    expect(second.job.availableAt).toBe(new Date(NOW + 3_000).toISOString());

    // 세 번째 시도: maxAttempts(3) 소진 → dlq
    await store.put({ ...second.job, state: 'waiting', availableAt: new Date(NOW).toISOString() });
    await store.reserve('worker-a');
    const third = await store.fail('job_1', new Error('still crashing'), { now: NOW + 2_000 });
    expect(third.willRetry).toBe(false);
    expect(third.job.state).toBe('dlq');
    expect(third.job.finishedAt).not.toBeNull();
  });

  it('재시도 불가 실패는 failed로 끝낸다', async () => {
    const { store } = setup();
    await store.put(job({ id: 'job_1' }));
    await store.reserve('worker-a');
    const result = await store.fail('job_1', new Error('invalid media'), { retryable: false, now: NOW });
    expect(result.job.state).toBe('failed');
    expect(result.willRetry).toBe(false);
  });

  it('임대가 만료된 active 작업을 재시도 대기로 되돌린다', async () => {
    const { store, server } = setup();
    await store.put(job({ id: 'job_1' }));
    await store.reserve('worker-a');

    const recovered = await store.recoverExpiredLeases(NOW + 31_000);
    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.state).toBe('delayed');
    expect(recovered[0]?.lastError).toContain('lease expired');
    expect(server.zsets.get(redisQueueKeys().lease)?.has('job_1')).toBe(false);

    // 아직 만료 전이면 건드리지 않는다
    await store.put(job({ id: 'job_2' }));
    await store.reserve('worker-a');
    expect(await store.recoverExpiredLeases(NOW + 1_000)).toHaveLength(0);
  });

  it('상태별 개수와 dedupeKey 조회', async () => {
    const { store } = setup();
    await store.put(job({ id: 'job_1', dedupeKey: 'episode-42' }));
    await store.put(job({ id: 'job_2', state: 'delayed', availableAt: new Date(NOW + 1_000).toISOString() }));
    await store.put(job({ id: 'job_3', state: 'completed', finishedAt: new Date(NOW).toISOString() }));

    const counts = await store.counts();
    expect(counts).toEqual({ waiting: 1, delayed: 1, active: 0, completed: 1, failed: 0, dlq: 0 });
    expect((await store.findByDedupeKey('episode-42'))?.id).toBe('job_1');
    expect(await store.findByDedupeKey('missing')).toBeUndefined();
  });

  it('모든 상태 전이가 상태 집합에 반영된다', async () => {
    const { store } = setup();
    await store.put(job({ id: 'job_1' }));
    await store.reserve('worker-a');
    await store.complete('job_1');
    const counts = await store.counts();
    expect(counts.active).toBe(0);
    expect(counts.completed).toBe(1);
    expect(JOB_STATES.every((state) => counts[state] >= 0)).toBe(true);
  });
});

describe('JobQueue 연동', () => {
  it('원자적 선점이 가능한 저장소를 자동으로 사용한다(두 워커가 백로그를 나눠 갖는다)', async () => {
    const { server } = setup();
    const store = new RedisQueueStore({ client: new FakeRedisClient(server), now: () => NOW });
    expect(isReservableStore(store)).toBe(true);

    const workerA = new JobQueue({ store, now: () => NOW });
    const workerB = new JobQueue({ store, now: () => NOW });
    await workerA.enqueue({ tenantId: 'tn-1', name: 'job a', priority: 5 });
    await workerA.enqueue({ tenantId: 'tn-1', name: 'job b', priority: 4 });

    const claimedByB = await workerB.reserve('worker-b');
    expect(claimedByB).not.toBeNull();
    expect(claimedByB?.workerId).toBe('worker-b');

    const claimedByA = await workerA.reserve('worker-a');
    expect(claimedByA).not.toBeNull();
    expect(claimedByA?.id).not.toBe(claimedByB?.id);

    expect(await workerA.reserve('worker-a')).toBeNull();
  });

  it('storeReserve=false면 첫 선점에서 저장소 백로그를 힙으로 복원한다(재시작 복구 경로)', async () => {
    const { server } = setup();
    const store = new RedisQueueStore({ client: new FakeRedisClient(server), now: () => NOW });
    const writer = new JobQueue({ store, now: () => NOW });
    const reader = new JobQueue({ store, now: () => NOW, storeReserve: false });
    await writer.enqueue({ tenantId: 'tn-1', name: 'job a' });

    // 힙 경로도 저장소를 한 번 읽어 백로그를 되살린다. 다만 "누가 먼저 가져가는가"는 두 프로세스가
    // 각자 판단하므로 원자적이지 않다 — 그 문제를 storeReserve(기본값) 경로가 해결한다.
    const claimed = await reader.reserve('worker-b');
    expect(claimed?.name).toBe('job a');
    expect(await reader.reserve('worker-b')).toBeNull();
  });
});

describe('드라이버 선택', () => {
  it('QUEUE_DRIVER를 해석하고, 모르는 값은 조용히 기본값으로 떨어지지 않는다', () => {
    expect(resolveQueueDriver({})).toBe('memory');
    expect(resolveQueueDriver({ QUEUE_DRIVER: 'redis' })).toBe('redis');
    expect(resolveQueueDriver({ QUEUE_DRIVER: ' FILE ' })).toBe('file');
    expect(() => resolveQueueDriver({ QUEUE_DRIVER: 'mysql' })).toThrowError(/unsupported QUEUE_DRIVER: mysql/);
    expect(() => resolveQueueDriver({ QUEUE_DRIVER: 'redsi' })).toThrowError(/unsupported QUEUE_DRIVER/);

    try {
      resolveQueueDriver({ QUEUE_DRIVER: 'mysql' });
    } catch (error) {
      expect((error as { code: string }).code).toBe('CONFIG');
      expect((error as { details: Record<string, unknown> }).details.hint).toContain('backend');
    }
  });

  it('드라이버별 저장소를 만들고, redis는 클라이언트 없이 만들지 않는다', () => {
    const server = new FakeRedisServer();
    expect(createQueueStore({ driver: 'memory' })).toBeInstanceOf(InMemoryQueueStore);
    expect(createQueueStore({ driver: 'redis', client: new FakeRedisClient(server) })).toBeInstanceOf(RedisQueueStore);
    expect(() => createQueueStore({ driver: 'redis' })).toThrowError(/requires a RedisTransactionClient/);

    const statePath = join(mkdtempSync(join(tmpdir(), 'sf-queue-')), 'state.json');
    expect(createQueueStore({ driver: 'file', statePath })).toBeInstanceOf(FileQueueStore);
  });
});
