import {
  QueueJobSchema,
  RetryPolicySchema,
  type JobState,
  type QueueCounts,
  type QueueJob,
  type RetryPolicy,
} from '../types/queue';
import { ShortformError } from '../lib/errors';
import { computeRetryDelay } from '../lib/queue/backoff';
import { FileQueueStore } from '../lib/queue/fileStore';
import { InMemoryQueueStore, type QueueStore } from '../lib/queue/jobQueue';

/**
 * Redis 큐 어댑터 — 여러 노드가 같은 백로그를 나눠 갖는 저장소
 *
 * 왜 어댑터가 따로 필요한가
 * ------------------------
 * `JobQueue`는 단일 프로세스 안에서 힙(`BinaryHeap`)으로 "다음에 뭘 꺼낼지"를 정한다. 워커가 한 대일 때는
 * 그게 가장 빠르다. 하지만 렌더 노드가 5대가 되는 순간 각자의 힙은 서로를 모르고, 같은 작업을 두 번
 * 집어간다. 그 중복을 막는 방법은 두 가지다: (1) 공유 저장소에서 **원자적으로** 집어간다, (2) 집어간 뒤
 * 감지해서 되돌린다. 2번은 같은 영상을 두 번 인코딩한 뒤에야 알 수 있으므로 비용이 크다. 이 어댑터는 1번을
 * 택했다.
 *
 * 원자성은 **Redis 트랜잭션(WATCH → MULTI → EXEC)** 으로 만든다.
 *   · `WATCH readyHash jobsHash`로 "내가 본 상태"를 고정하고,
 *   · `ZRANGEBYSCORE ready -inf now LIMIT 0 1`로 후보를 고른 뒤,
 *   · `MULTI … EXEC`에서 `ZREM ready` + `HSET jobs` + 상태 인덱스 이동을 한 번에 커밋한다.
 *   · 그 사이에 다른 노드가 같은 키를 건드렸다면 `EXEC`가 **nil**을 돌려준다(충돌). 그러면 다시 고른다.
 *
 * Lua 스크립트 대신 트랜잭션을 쓴 이유
 * -----------------------------------
 * · Lua는 강력하지만 `EVAL`이 막힌 관리형 Redis(일부 클라우드는 스크립트를 제한한다)에서 그대로 깨진다.
 * · WATCH/EXEC는 Redis 2.0부터 있는 기본 동작이고, **경합이 드물 때 더 빠르다**(경합이 없으면 왕복 2회).
 * · 무엇보다, 이 선택은 단위 테스트로 검증할 수 있다. 스크립트를 흉내 내는 테스트는 스크립트가 맞다는 걸
 *   증명하지 못하지만, WATCH 충돌은 가짜 서버에서도 **실제 의미 그대로** 재현된다(`tests/redisAdapter.test.ts`).
 *
 * 키 설계
 * -------
 * ```
 * {prefix}:jobs            HASH   jobId → QueueJob JSON (단일 진실)
 * {prefix}:state:{state}   SET    상태별 id 인덱스 (counts·운영 화면용)
 * {prefix}:ready           ZSET   id → availableAt(ms). 실행 가능 시각 순
 * {prefix}:delayed         ZSET   id → availableAt(ms). 지연·재시도 대기
 * {prefix}:lease           ZSET   id → leaseExpiresAt(ms). active 작업의 소유권 증거
 * {prefix}:dedupe          HASH   dedupeKey → jobId (중복 인큐 방지)
 * ```
 * JSON이 단일 진실이고 나머지는 인덱스다. 인덱스가 어긋나면 `reserve`가 상태를 확인해 스스로 고친다
 * (stale entry는 `ZREM`하고 넘어간다). 인덱스를 믿지 않고 매번 원본을 확인하는 것이, "큐가 유령 작업을
 * 돌려주는" 사고를 막는다.
 *
 * 클라이언트는 주입받는다
 * ---------------------
 * 이 패키지는 Redis 클라이언트에 의존하지 않는다. 4개 메서드만 구현하면 ioredis·node-redis·테스트용
 * 가짜 서버 무엇이든 붙는다(`RedisTransactionClient`). 실제 연결 예시는 README § "Redis 큐" 참고.
 */

/* ------------------------------------------------------------------ */
/* 클라이언트 계약                                                     */
/* ------------------------------------------------------------------ */

/** `["HSET", key, field, value]` 형태의 커맨드 배열. 클라이언트가 그대로 실행한다. */
export type RedisCommand = [command: string, ...args: (string | number)[]];

export interface RedisTransactionClient {
  /** 파이프라인 실행. 응답 배열은 커맨드 순서와 같다. */
  send(commands: RedisCommand[]): Promise<unknown[]>;
  /** 이후 `multi`가 실패하도록 키를 지켜본다. 다른 클라이언트의 쓰기가 있으면 EXEC가 취소된다. */
  watch(keys: string[]): Promise<void>;
  /** WATCH한 키가 그대로면 커맨드를 원자적으로 실행하고 응답을, 하나라도 바뀌었으면 `null`을 돌려준다. */
  multi(commands: RedisCommand[]): Promise<unknown[] | null>;
  /** 지켜보기를 해제한다. */
  unwatch(): Promise<void>;
  close?(): Promise<void>;
}

export interface RedisQueueKeys {
  jobs: string;
  ready: string;
  delayed: string;
  lease: string;
  dedupe: string;
  state(state: JobState): string;
  all(): string[];
}

export const JOB_STATES: readonly JobState[] = ['waiting', 'delayed', 'active', 'completed', 'failed', 'dlq'];

export function redisQueueKeys(prefix = 'sf:queue'): RedisQueueKeys {
  const base = prefix.replace(/:+$/, '');
  return {
    jobs: `${base}:jobs`,
    ready: `${base}:ready`,
    delayed: `${base}:delayed`,
    lease: `${base}:lease`,
    dedupe: `${base}:dedupe`,
    state: (state) => `${base}:state:${state}`,
    all: () => [
      `${base}:jobs`,
      `${base}:dedupe`,
      `${base}:ready`,
      `${base}:delayed`,
      `${base}:lease`,
      ...JOB_STATES.map((state) => `${base}:state:${state}`),
    ],
  };
}

/* ------------------------------------------------------------------ */
/* 직렬화                                                              */
/* ------------------------------------------------------------------ */

function parseJob(raw: unknown): QueueJob | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  try {
    const parsed = QueueJobSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function msOf(value: string | null): number {
  return value ? Date.parse(value) : Number.NaN;
}

/* ------------------------------------------------------------------ */
/* 예약(선점) 능력을 가진 저장소                                       */
/* ------------------------------------------------------------------ */

export interface ReserveOptions {
  now?: number;
  leaseTimeoutMs?: number;
}

/**
 * `QueueStore`에 원자적 선점을 더한 표면.
 * `JobQueue`는 저장소가 이 인터페이스를 만족하면 힙 대신 이쪽을 쓴다(자동 감지).
 */
export interface ReservableQueueStore extends QueueStore {
  reserve(workerId: string, options?: ReserveOptions): Promise<QueueJob | null>;
  promoteDelayed(now?: number): Promise<number>;
}

export function isReservableStore(store: QueueStore): store is ReservableQueueStore {
  const candidate = store as Partial<ReservableQueueStore>;
  return typeof candidate.reserve === 'function' && typeof candidate.promoteDelayed === 'function';
}

/* ------------------------------------------------------------------ */
/* 어댑터                                                              */
/* ------------------------------------------------------------------ */

export interface RedisQueueStoreOptions {
  client: RedisTransactionClient;
  /** 여러 서비스가 같은 Redis를 쓸 때 충돌하지 않도록 네임스페이스를 준다 */
  prefix?: string;
  now?: () => number;
  random?: () => number;
  retry?: Partial<RetryPolicy>;
  /** WATCH 충돌 시 재시도 횟수. 노드가 늘수록 충돌도 늘어난다 */
  maxClaimAttempts?: number;
  /** 충돌 직후 대기(ms). 0이면 즉시 재시도(테스트) */
  sleep?: (ms: number) => Promise<void>;
}

export class RedisQueueStore implements ReservableQueueStore {
  readonly keys: RedisQueueKeys;
  private readonly client: RedisTransactionClient;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly retry: RetryPolicy;
  private readonly maxClaimAttempts: number;
  private readonly sleep: (ms: number) => Promise<void>;
  /**
   * WATCH는 **연결 단위** 상태다. 한 연결에서 두 선점이 겹치면 나중 WATCH가 앞의 것을 덮어써
   * 충돌 감지가 무력해진다. 그래서 이 인스턴스 안에서는 WATCH를 쓰는 연산을 직렬화한다.
   * 노드를 늘리는 쪽은 인스턴스(연결)를 늘리는 것이고, 그 경합은 Redis가 막는다.
   */
  private watchChain: Promise<unknown> = Promise.resolve();

  constructor(options: RedisQueueStoreOptions) {
    this.client = options.client;
    this.keys = redisQueueKeys(options.prefix);
    this.now = options.now ?? (() => Date.now());
    this.random = options.random ?? Math.random;
    this.retry = RetryPolicySchema.parse({
      maxAttempts: 3,
      baseDelayMs: 1_000,
      maxDelayMs: 30_000,
      jitterRatio: 0.5,
      ...options.retry,
    });
    this.maxClaimAttempts = Math.max(1, options.maxClaimAttempts ?? 20);
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /* ---------------- QueueStore ---------------- */

  async get(id: string): Promise<QueueJob | undefined> {
    const [raw] = await this.client.send([['HGET', this.keys.jobs, id]]);
    return parseJob(raw) ?? undefined;
  }

  async all(): Promise<QueueJob[]> {
    const [raw] = await this.client.send([['HGETALL', this.keys.jobs]]);
    if (!Array.isArray(raw)) return [];
    const jobs: QueueJob[] = [];
    // HGETALL 응답은 [field, value, field, value, …]
    for (let index = 0; index < raw.length; index += 2) {
      const job = parseJob(raw[index + 1]);
      if (job) jobs.push(job);
    }
    return jobs;
  }

  async put(job: QueueJob): Promise<void> {
    await this.send(this.upsertCommands(job));
  }

  async delete(id: string): Promise<void> {
    const existing = await this.get(id);
    await this.send(this.deleteCommands(id, existing ?? null));
  }

  /** 이 어댑터가 소유한 키만 지운다(같은 Redis의 다른 데이터는 건드리지 않는다). */
  async clear(): Promise<void> {
    await this.send(this.keys.all().map((key) => ['DEL', key] as RedisCommand));
  }

  /* ---------------- 인덱스 동기화 ---------------- */

  private async send(commands: RedisCommand[]): Promise<unknown[]> {
    if (commands.length === 0) return [];
    try {
      return await this.client.send(commands);
    } catch (error) {
      throw new ShortformError('redis queue store command failed', {
        code: 'CONFIG',
        cause: error,
        details: { command: commands[0]?.[0] ?? 'unknown' },
      });
    }
  }

  /**
   * 한 작업을 모든 인덱스에 반영하는 커맨드 묶음.
   * 상태 SET은 6개를 모두 SREM한 뒤 하나만 SADD한다 — 이전 상태를 몰라도 되고, 남은 인덱스가 없다.
   */
  private upsertCommands(job: QueueJob): RedisCommand[] {
    const commands: RedisCommand[] = [
      ['HSET', this.keys.jobs, job.id, JSON.stringify(job)],
      ['ZREM', this.keys.ready, job.id],
      ['ZREM', this.keys.delayed, job.id],
      ['ZREM', this.keys.lease, job.id],
      ...JOB_STATES.map((state) => ['SREM', this.keys.state(state), job.id] as RedisCommand),
      ['SADD', this.keys.state(job.state), job.id],
    ];

    const availableAt = msOf(job.availableAt);
    if (job.state === 'waiting' && Number.isFinite(availableAt)) {
      commands.push(['ZADD', this.keys.ready, availableAt, job.id]);
    } else if (job.state === 'delayed' && Number.isFinite(availableAt)) {
      commands.push(['ZADD', this.keys.delayed, availableAt, job.id]);
    }

    const leaseExpiry = job.state === 'active' ? msOf(job.leaseExpiresAt) : Number.NaN;
    if (Number.isFinite(leaseExpiry)) commands.push(['ZADD', this.keys.lease, leaseExpiry, job.id]);

    if (job.dedupeKey) commands.push(['HSET', this.keys.dedupe, job.dedupeKey, job.id]);
    return commands;
  }

  private deleteCommands(id: string, existing: QueueJob | null): RedisCommand[] {
    const commands: RedisCommand[] = [
      ['HDEL', this.keys.jobs, id],
      ['ZREM', this.keys.ready, id],
      ['ZREM', this.keys.delayed, id],
      ['ZREM', this.keys.lease, id],
      ...JOB_STATES.map((state) => ['SREM', this.keys.state(state), id] as RedisCommand),
    ];
    if (existing?.dedupeKey) {
      // 같은 dedupeKey가 다른 작업으로 덮여 있으면 지우지 않는다.
      commands.push(['HDEL', this.keys.dedupe, existing.dedupeKey]);
    }
    return commands;
  }

  /* ---------------- 원자적 선점 ---------------- */

  /**
   * 실행 가능한 작업 하나를 원자적으로 가져간다. 여러 노드가 동시에 호출해도 같은 작업을 두 번 주지 않는다.
   * 반환된 작업은 이미 `active`이고 `attempts`가 1 증가한 상태다.
   */
  async reserve(workerId: string, options: ReserveOptions = {}): Promise<QueueJob | null> {
    if (!workerId) throw new ShortformError('workerId is required to reserve', { code: 'VALIDATION' });
    return this.serialize(() => this.reserveOnce(workerId, options));
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.watchChain.then(operation, operation);
    this.watchChain = next.catch(() => undefined);
    return next;
  }

  private async reserveOnce(workerId: string, options: ReserveOptions): Promise<QueueJob | null> {
    const nowMs = options.now ?? this.now();
    const leaseMs = options.leaseTimeoutMs ?? 30_000;

    for (let attempt = 0; attempt < this.maxClaimAttempts; attempt += 1) {
      await this.client.watch([this.keys.ready, this.keys.jobs]);

      const [dueIds] = await this.client.send([
        ['ZRANGEBYSCORE', this.keys.ready, '-inf', nowMs, 'LIMIT', 0, 1],
      ]);
      const id = Array.isArray(dueIds) ? String(dueIds[0] ?? '') : '';
      if (!id) {
        await this.client.unwatch();
        return null;
      }

      const [raw] = await this.client.send([['HGET', this.keys.jobs, id]]);
      const job = parseJob(raw);

      // 유령 인덱스(stale entry): 작업이 없거나 이미 대기 상태가 아니다. 인덱스만 정리하고 다음 후보로.
      if (!job || job.state !== 'waiting') {
        await this.client.multi([['ZREM', this.keys.ready, id]]);
        continue;
      }
      if (Number.isFinite(msOf(job.availableAt)) && msOf(job.availableAt) > nowMs) {
        // 아직 때가 아닌데 ready에 들어와 있다 → delayed로 옮기고 다음 후보로.
        await this.client.multi([['ZREM', this.keys.ready, id]]);
        await this.put({ ...job, state: 'delayed' });
        continue;
      }

      const startedAt = iso(nowMs);
      const claimed: QueueJob = {
        ...job,
        state: 'active',
        attempts: job.attempts + 1,
        workerId,
        startedAt: job.startedAt ?? startedAt,
        leaseExpiresAt: iso(nowMs + leaseMs),
        updatedAt: startedAt,
        transitions: [
          ...job.transitions,
          { from: 'waiting', to: 'active', at: startedAt, reason: `reserved by ${workerId}` },
        ],
      };

      const result = await this.client.multi([
        ['HSET', this.keys.jobs, id, JSON.stringify(claimed)],
        ['ZREM', this.keys.ready, id],
        ['SREM', this.keys.state('waiting'), id],
        ['SADD', this.keys.state('active'), id],
        ['ZADD', this.keys.lease, nowMs + leaseMs, id],
      ]);

      if (result === null) {
        // 다른 노드가 먼저 가져갔다. 바로 다시 걸면 같은 순간에 계속 부딪히므로(라이브락) 조금 쉰다.
        if (attempt >= 2) await this.sleep(Math.min(10, attempt));
        continue;
      }
      return claimed;
    }

    throw new ShortformError('could not claim a job after repeated WATCH conflicts', {
      code: 'CONFIG',
      details: { workerId, attempts: this.maxClaimAttempts },
    });
  }

  /**
   * 지연 작업 중 때가 된 것을 `waiting`으로 승격한다.
   * 점수(availableAt)가 이미 지난 것만 옮기므로, 승격된 작업은 즉시 선점 가능하다.
   */
  async promoteDelayed(now = this.now()): Promise<number> {
    return this.serialize(() => this.promoteDelayedOnce(now));
  }

  private async promoteDelayedOnce(now: number): Promise<number> {
    let promoted = 0;
    for (;;) {
      await this.client.watch([this.keys.delayed, this.keys.jobs]);
      const [ids] = await this.client.send([['ZRANGEBYSCORE', this.keys.delayed, '-inf', now, 'LIMIT', 0, 100]]);
      const list = Array.isArray(ids) ? ids.map(String) : [];
      if (list.length === 0) {
        await this.client.unwatch();
        return promoted;
      }

      const values = await this.client.send(list.map((id) => ['HGET', this.keys.jobs, id] as RedisCommand));
      const commands: RedisCommand[] = [];
      for (let index = 0; index < list.length; index += 1) {
        const id = list[index] as string;
        const job = parseJob(values[index]);
        if (!job || job.state !== 'delayed') {
          commands.push(['ZREM', this.keys.delayed, id]);
          continue;
        }
        const at = iso(now);
        const promotedJob: QueueJob = {
          ...job,
          state: 'waiting',
          updatedAt: at,
          transitions: [...job.transitions, { from: 'delayed', to: 'waiting', at, reason: 'delay elapsed' }],
        };
        commands.push(
          ['HSET', this.keys.jobs, id, JSON.stringify(promotedJob)],
          ['ZREM', this.keys.delayed, id],
          ['ZADD', this.keys.ready, now, id],
          ['SREM', this.keys.state('delayed'), id],
          ['SADD', this.keys.state('waiting'), id],
        );
        promoted += 1;
      }

      const result = await this.client.multi(commands);
      if (result !== null) return promoted; // 다음 배치는 다음 호출에서
    }
  }

  /** active 작업의 임대를 연장한다. 소유자가 아니면 거부한다. */
  async heartbeat(jobId: string, workerId: string, leaseTimeoutMs = 30_000, options: { now?: number } = {}): Promise<QueueJob> {
    const nowMs = options.now ?? this.now();
    const job = await this.require(jobId);
    if (job.state !== 'active') {
      throw new ShortformError(`job ${jobId} is ${job.state}, not active`, { code: 'VALIDATION' });
    }
    if (job.workerId !== workerId) {
      throw new ShortformError(`job ${jobId} is leased by ${job.workerId ?? 'nobody'}`, { code: 'VALIDATION' });
    }
    const updated: QueueJob = { ...job, leaseExpiresAt: iso(nowMs + leaseTimeoutMs), updatedAt: iso(nowMs) };
    await this.send(this.upsertCommands(updated));
    return updated;
  }

  async complete(jobId: string, result: unknown = null, options: { now?: number } = {}): Promise<QueueJob> {
    const nowMs = options.now ?? this.now();
    const job = await this.require(jobId);
    if (job.state === 'completed') return job;
    if (job.state !== 'active') {
      throw new ShortformError(`job ${jobId} is ${job.state}, not active`, { code: 'VALIDATION' });
    }
    const at = iso(nowMs);
    const updated: QueueJob = {
      ...job,
      state: 'completed',
      progress: 100,
      result,
      leaseExpiresAt: null,
      finishedAt: at,
      updatedAt: at,
      transitions: [...job.transitions, { from: 'active', to: 'completed', at }],
    };
    await this.send(this.upsertCommands(updated));
    return updated;
  }

  /**
   * 실패 기록. 재시도 가능하고 시도가 남았으면 `delayed`로 되돌리고, 아니면 `dlq`/`failed`로 끝낸다.
   * 백오프 계산은 `JobQueue`와 **같은 함수**를 쓴다(두 곳의 재시도 간격이 달라지면 장애 분석이 불가능해진다).
   */
  async fail(
    jobId: string,
    error: unknown,
    options: { retryable?: boolean; now?: number } = {},
  ): Promise<{ job: QueueJob; willRetry: boolean }> {
    const nowMs = options.now ?? this.now();
    const job = await this.require(jobId);
    if (job.state !== 'active') {
      throw new ShortformError(`job ${jobId} is ${job.state}, not active`, { code: 'VALIDATION' });
    }
    const message = error instanceof Error ? error.message : String(error);
    const retryable = options.retryable ?? true;
    const at = iso(nowMs);
    const base: QueueJob = {
      ...job,
      lastError: message,
      workerId: null,
      leaseExpiresAt: null,
      updatedAt: at,
    };

    if (retryable && job.attempts < job.maxAttempts) {
      const delayMs = computeRetryDelay(job.attempts, this.retry, this.random);
      const delayed: QueueJob = {
        ...base,
        state: 'delayed',
        availableAt: iso(nowMs + delayMs),
        transitions: [
          ...job.transitions,
          { from: 'active', to: 'delayed', at, reason: `retry ${job.attempts + 1}/${job.maxAttempts} in ${delayMs}ms` },
        ],
      };
      await this.send(this.upsertCommands(delayed));
      return { job: delayed, willRetry: true };
    }

    const terminal: QueueJob = {
      ...base,
      state: retryable ? 'dlq' : 'failed',
      finishedAt: at,
      transitions: [...job.transitions, { from: 'active', to: retryable ? 'dlq' : 'failed', at, reason: retryable ? 'retries exhausted' : 'non-retryable' }],
    };
    await this.send(this.upsertCommands(terminal));
    return { job: terminal, willRetry: false };
  }

  /**
   * 임대가 만료된 active 작업을 재시도 대기로 되돌린다(워커 OOM·노드 드레인·시계 오차).
   * DLQ로 바로 보내지 않는 이유: 워커가 한 번 죽었다고 작업이 영구 실패한 것은 아니다.
   */
  async recoverExpiredLeases(now = this.now()): Promise<QueueJob[]> {
    const [ids] = await this.client.send([['ZRANGEBYSCORE', this.keys.lease, '-inf', now]]);
    const list = Array.isArray(ids) ? ids.map(String) : [];
    const recovered: QueueJob[] = [];
    for (const id of list) {
      const job = await this.get(id);
      if (!job) {
        await this.send([['ZREM', this.keys.lease, id]]);
        continue;
      }
      if (job.state !== 'active') {
        await this.send([['ZREM', this.keys.lease, id]]);
        continue;
      }
      const { job: next } = await this.fail(id, new Error('lease expired: worker stopped responding'), { now });
      recovered.push(next);
    }
    return recovered;
  }

  async counts(): Promise<QueueCounts> {
    const values = await this.client.send(JOB_STATES.map((state) => ['SCARD', this.keys.state(state)] as RedisCommand));
    const numbers = Array.isArray(values) ? values : [];
    const counts: QueueCounts = { waiting: 0, delayed: 0, active: 0, completed: 0, failed: 0, dlq: 0 };
    JOB_STATES.forEach((state, index) => {
      counts[state] = Math.max(0, Math.round(Number(numbers[index] ?? 0)));
    });
    return counts;
  }

  /** dedupeKey로 살아 있는 작업을 찾는다(중복 인큐 방지). */
  async findByDedupeKey(dedupeKey: string): Promise<QueueJob | undefined> {
    const [id] = await this.client.send([['HGET', this.keys.dedupe, dedupeKey]]);
    return typeof id === 'string' && id ? this.get(id) : undefined;
  }

  async close(): Promise<void> {
    await this.client.close?.();
  }

  private async require(jobId: string): Promise<QueueJob> {
    const job = await this.get(jobId);
    if (!job) throw new ShortformError(`job ${jobId} not found`, { code: 'VALIDATION' });
    return job;
  }
}

/* ------------------------------------------------------------------ */
/* 드라이버 선택                                                       */
/* ------------------------------------------------------------------ */

export type QueueDriver = 'redis' | 'file' | 'memory';

export const QUEUE_DRIVERS: readonly QueueDriver[] = ['redis', 'file', 'memory'];

/**
 * `QUEUE_DRIVER` 해석. 잘못된 값은 조용히 기본값으로 떨어지지 않고 실패한다 —
 * 운영에서 오타 하나로 인메모리 큐가 돌면 재시작할 때 백로그가 사라진다.
 *
 * `mysql`은 이 패키지에 없다. MySQL 기반 큐는 PHP 백엔드(`backend/src/Repositories/ShortformRepository.php`)가
 * `SELECT … FOR UPDATE SKIP LOCKED`로 담당한다. Node 서비스에서 MySQL을 쓰려면 이 파일의 `QueueStore`
 * 구현을 하나 더 추가해 주입하는 것이 맞다(스키마·잠금 규칙이 두 벌이 되면 안 되기 때문).
 */
export function resolveQueueDriver(env: NodeJS.ProcessEnv = process.env): QueueDriver {
  const raw = (env.QUEUE_DRIVER ?? 'memory').trim().toLowerCase();
  if (raw === '' || raw === 'memory') return 'memory';
  if (raw === 'redis' || raw === 'file') return raw;
  throw new ShortformError(`unsupported QUEUE_DRIVER: ${raw}`, {
    code: 'CONFIG',
    details: { supported: QUEUE_DRIVERS, hint: 'mysql 큐는 backend/(PHP)가 담당합니다.' },
  });
}

export interface CreateQueueStoreOptions {
  driver?: QueueDriver;
  env?: NodeJS.ProcessEnv;
  /** driver=redis일 때 필수 */
  client?: RedisTransactionClient;
  prefix?: string;
  /** driver=file일 때 경로 */
  statePath?: string;
}

/**
 * 환경변수 기반 저장소 선택. `file`은 CLI/데모, `memory`는 테스트, `redis`는 다중 노드 운영.
 * 반환 타입을 `QueueStore`로 좁혀 두면 호출부는 어느 드라이버인지 몰라도 된다.
 */
export function createQueueStore(options: CreateQueueStoreOptions = {}): QueueStore {
  const driver = options.driver ?? resolveQueueDriver(options.env);
  if (driver === 'redis') {
    if (!options.client) {
      throw new ShortformError('QUEUE_DRIVER=redis requires a RedisTransactionClient', {
        code: 'CONFIG',
        details: { hint: 'createQueueStore({ driver: "redis", client })로 주입하세요.' },
      });
    }
    return new RedisQueueStore({ client: options.client, prefix: options.prefix });
  }
  if (driver === 'file') {
    return new FileQueueStore(options.statePath ?? '.work/queue/state.json');
  }
  return new InMemoryQueueStore();
}
