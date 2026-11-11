import { afterEach, describe, expect, it } from 'vitest';
import { JobQueue } from '../src/lib/queue/jobQueue';
import { TenantRegistry } from '../src/lib/rateLimit/tenantRegistry';
import { StudioApi } from '../src/services/studio/api';
import { StudioConsole } from '../src/services/studio/console';
import { DlqActionService } from '../src/services/studio/dlqActions';
import { startStudioServer, type StudioServerHandle } from '../src/services/studio/server';

const T0 = Date.parse('2026-11-11T00:00:00.000Z');

function build() {
  let clock = T0;
  const queue = new JobQueue({
    now: () => clock,
    // maxAttempts 1: a single failure is immediately terminal, which is how a job reaches the DLQ.
    retry: { maxAttempts: 1, baseDelayMs: 5, maxDelayMs: 20, jitterRatio: 0 },
    idFactory: (() => {
      let index = 0;
      return () => `job_${++index}`;
    })(),
  });
  const dlq = new DlqActionService({ queue, now: () => clock });
  const tenants = new TenantRegistry({ now: () => clock });
  tenants.register({ id: 'agency-a', name: 'Agency A', plan: 'agency' });
  const studioConsole = new StudioConsole({ queue, tenants, dlq, now: () => clock });
  return {
    queue,
    dlq,
    console: studioConsole,
    api: new StudioApi(studioConsole),
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

async function enqueueAndFail(queue: JobQueue, name = '주방 수납 릴스'): Promise<string> {
  const job = await queue.enqueue({ tenantId: 'agency-a', name, maxAttempts: 1 });
  await queue.reserve('worker-1');
  await queue.fail(job.id, new Error('ffmpeg exited 1'));
  return job.id;
}

describe('DLQ 재시도 / 폐기 서비스', () => {
  it("DLQ 작업을 재시도하면 대기열로 돌아가고 시도 횟수가 초기화된다", async () => {
    const { queue, dlq } = build();
    const jobId = await enqueueAndFail(queue);

    expect((await queue.list('dlq')).map((job) => job.id)).toEqual([jobId]);

    const outcome = await dlq.retry(jobId, 'seunghye');

    expect(outcome.ok).toBe(true);
    expect(outcome.status).toBe(200);
    expect(outcome.state).toBe('waiting');
    expect(await queue.list('dlq')).toHaveLength(0);
    const requeued = await queue.get(jobId);
    expect(requeued?.attempts).toBe(0);
    expect(requeued?.lastError).toBeNull();
    expect(requeued?.transitions.at(-1)?.reason).toContain('replayed');
    expect(dlq.recent()[0]).toMatchObject({ action: 'retry', outcome: 'applied', actor: 'seunghye' });
  });

  it("이미 재시도한 작업을 또 누르면 거부하고 기록만 남긴다", async () => {
    const { queue, dlq } = build();
    const jobId = await enqueueAndFail(queue);
    await dlq.retry(jobId);

    const second = await dlq.retry(jobId);

    expect(second.ok).toBe(false);
    expect(second.status).toBe(409);
    expect(second.message).toContain('waiting');
    expect(dlq.recent()[0]).toMatchObject({ action: 'retry', outcome: 'rejected' });
  });

  it("폐기하면 DLQ에서 사라지고 이벤트 로그에 사유가 남는다", async () => {
    const { queue, dlq } = build();
    const jobId = await enqueueAndFail(queue);

    const outcome = await dlq.discard(jobId, 'seunghye');

    expect(outcome.ok).toBe(true);
    expect(outcome.state).toBe('discarded');
    expect(await queue.get(jobId)).toBeUndefined();
    expect(await queue.list('dlq')).toHaveLength(0);
    const discarded = queue.events.find((event) => event.type === 'discarded');
    expect(discarded).toBeDefined();
    expect(discarded && 'reason' in discarded ? discarded.reason : '').toContain('seunghye');
  });

  it("폐기한 작업을 다시 폐기하면 404", async () => {
    const { queue, dlq } = build();
    const jobId = await enqueueAndFail(queue);
    await dlq.discard(jobId);

    const again = await dlq.discard(jobId);

    expect(again.ok).toBe(false);
    expect(again.status).toBe(404);
    expect(again.message).toContain('찾을 수 없습니다');
  });

  it("실행 중(active) 작업은 조작을 거부한다", async () => {
    const { queue, dlq } = build();
    const job = await queue.enqueue({ tenantId: 'agency-a', name: '진행 중 렌더' });
    await queue.reserve('worker-1');

    const retry = await dlq.retry(job.id);
    const discard = await dlq.discard(job.id);

    expect(retry.status).toBe(409);
    expect(discard.status).toBe(409);
    expect((await queue.get(job.id))?.state).toBe('active');
  });

  it("비재시도 실패(failed) 작업도 폐기할 수 있다", async () => {
    const { queue, dlq } = build();
    const job = await queue.enqueue({ tenantId: 'agency-a', name: '권한 만료 렌더' });
    await queue.reserve('worker-1');
    await queue.fail(job.id, new Error('token revoked'));

    const outcome = await dlq.discard(job.id);

    expect(outcome.ok).toBe(true);
    expect(await queue.get(job.id)).toBeUndefined();
  });

  it("빈 jobId는 404로 거부한다", async () => {
    const { dlq } = build();
    const outcome = await dlq.retry('   ');
    expect(outcome.status).toBe(404);
    expect(dlq.size).toBe(1);
  });

  it("운영 기록은 최근 순서로 유지되고 상한을 넘지 않는다", async () => {
    const { queue, dlq } = build();
    const first = await enqueueAndFail(queue);
    const second = await enqueueAndFail(queue);
    await dlq.retry(first);
    await dlq.discard(second);

    const recent = dlq.recent(5);
    expect(recent.map((record) => record.action)).toEqual(['discard', 'retry']);
    expect(dlq.recent(1)).toHaveLength(1);
  });
});

describe('콘솔 스냅샷과 렌더링', () => {
  it("DLQ 항목에 재시도 예산·대기 시간·진행률을 담는다", async () => {
    const { queue, console: studioConsole, advance } = build();
    await enqueueAndFail(queue, '자막 렌더 실패');
    advance(90_000);

    const snapshot = await studioConsole.snapshot();

    expect(snapshot.dlq).toHaveLength(1);
    expect(snapshot.dlq[0]).toMatchObject({ attempts: 1, maxAttempts: 1, progress: 0 });
    expect(snapshot.dlq[0]?.failedAgoMs).toBe(90_000);
    expect(snapshot.dlqActions).toEqual([]);
  });

  it("텍스트 콘솔이 조작 명령과 운영 로그를 보여 준다", async () => {
    const { queue, console: studioConsole, dlq } = build();
    const jobId = await enqueueAndFail(queue);
    await dlq.retry(jobId);
    // 재시도된 작업을 워커가 집어 완료시켜 대기열을 비운 뒤, 두 번째 실패를 만든다.
    const rerun = await queue.reserve('worker-2');
    if (rerun) await queue.complete(rerun.id);
    await enqueueAndFail(queue, '두 번째 실패');

    const text = studioConsole.renderText(await studioConsole.snapshot());

    expect(text).toContain('DEAD LETTER QUEUE');
    expect(text).toContain('DLQ OPERATOR LOG');
    expect(text).toContain('queue replay');
  });

  it("HTML에 원클릭 재시도/폐기 폼과 API 경로를 넣는다", async () => {
    const { queue, console: studioConsole } = build();
    const jobId = await enqueueAndFail(queue);

    const html = studioConsole.renderHtml(await studioConsole.snapshot());

    expect(html).toContain('data-dlq="retry"');
    expect(html).toContain('data-dlq="discard"');
    expect(html).toContain(`/v1/queue/dlq/${jobId}/retry`);
    expect(html).toContain(`/v1/queue/dlq/${jobId}/discard`);
    expect(html).toContain('재시도');
    expect(html).toContain('폐기');
  });

  it("파일로 내보낸 HTML은 버튼을 비활성으로 그리고 이유를 적는다", async () => {
    const { queue, console: studioConsole } = build();
    await enqueueAndFail(queue);

    const html = studioConsole.renderHtml(await studioConsole.snapshot(), { standalone: true });

    expect(html).toContain('버튼 비활성');
    expect(html).not.toContain('data-dlq="retry"');
    expect(html).toContain('--serve');
  });

  it("작업 이름의 HTML을 이스케이프한다", async () => {
    const { queue, console: studioConsole } = build();
    await enqueueAndFail(queue, '<img src=x onerror=alert(1)>');

    const html = studioConsole.renderHtml(await studioConsole.snapshot());

    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x');
  });

  it("DLQ 조작 서비스가 없으면 조작 요청을 거부한다(읽기 전용 콘솔)", async () => {
    const queue = new JobQueue({ now: () => T0 });
    const tenants = new TenantRegistry({ now: () => T0 });
    tenants.register({ id: 'a', name: 'A', plan: 'starter' });
    const readOnly = new StudioConsole({ queue, tenants, now: () => T0 });
    const jobId = await enqueueAndFail(queue);

    const outcome = await readOnly.retryDlqJob(jobId);

    expect(outcome.ok).toBe(false);
    expect(readOnly.canOperateDlq).toBe(false);
    expect(outcome.message).toContain('DlqActionService');
  });
});

describe('DLQ HTTP API', () => {
  it("POST retry가 작업을 대기열로 되돌린다", async () => {
    const { queue, api } = build();
    const jobId = await enqueueAndFail(queue);

    const response = await api.handle({ method: 'POST', path: `/v1/queue/dlq/${jobId}/retry`, body: { actor: 'seunghye' } });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ ok: true, action: 'retry', jobId, state: 'waiting' });
    expect((await queue.get(jobId))?.state).toBe('waiting');
  });

  it("POST discard가 작업을 지운다", async () => {
    const { queue, api } = build();
    const jobId = await enqueueAndFail(queue);

    const response = await api.handle({ method: 'POST', path: `/v1/queue/dlq/${jobId}/discard` });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ ok: true, action: 'discard', state: 'discarded' });
    expect(await queue.get(jobId)).toBeUndefined();
  });

  it("없는 작업은 404, 잘못된 상태는 409", async () => {
    const { api, queue } = build();
    const missing = await api.handle({ method: 'POST', path: '/v1/queue/dlq/job_missing/retry' });
    expect(missing.status).toBe(404);

    const job = await queue.enqueue({ tenantId: 'agency-a', name: '대기 중' });
    const wrongState = await api.handle({ method: 'POST', path: `/v1/queue/dlq/${job.id}/discard` });
    expect(wrongState.status).toBe(409);
  });

  it("알 수 없는 DLQ 동작은 404", async () => {
    const { api } = build();
    const response = await api.handle({ method: 'POST', path: '/v1/queue/dlq/job_1/explode' });
    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ error: 'unknown_dlq_action' });
  });

  it("PUT은 405로 거부하고 허용 메서드를 알려 준다", async () => {
    const { api } = build();
    const response = await api.handle({ method: 'PUT', path: '/v1/snapshot' });
    expect(response.status).toBe(405);
    expect(response.headers?.allow).toBe('GET, POST');
  });

  it("GET / 은 조작 버튼이 살아 있는 콘솔 HTML을 준다", async () => {
    const { queue, api } = build();
    const jobId = await enqueueAndFail(queue);

    const response = await api.handle({ method: 'GET', path: '/' });

    expect(response.status).toBe(200);
    expect(response.contentType).toContain('text/html');
    const html = String(response.body);
    expect(html).toContain(`/v1/queue/dlq/${jobId}/retry`);
  });

  it("GET /v1/queue/dlq 는 항목과 운영 기록을 함께 준다", async () => {
    const { queue, api } = build();
    const jobId = await enqueueAndFail(queue);
    await api.handle({ method: 'POST', path: `/v1/queue/dlq/${jobId}/retry` });

    const response = await api.handle({ method: 'GET', path: '/v1/queue/dlq' });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ count: 0 });
    expect((response.body as { actions: unknown[] }).actions).toHaveLength(1);
  });
});

describe('스튜디오 HTTP 서버 (실제 요청)', () => {
  let handle: StudioServerHandle | null = null;

  afterEach(async () => {
    if (handle) await handle.close();
    handle = null;
  });

  it("같은 오리진에서 콘솔 페이지와 조작 API를 제공한다", async () => {
    const { queue, console: studioConsole, api } = build();
    const jobId = await enqueueAndFail(queue);
    handle = await startStudioServer({ console: studioConsole, api });

    const page = await fetch(`${handle.url}/`);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toContain('text/html');
    expect(await page.text()).toContain(`/v1/queue/dlq/${jobId}/retry`);

    const retried = await fetch(`${handle.url}/v1/queue/dlq/${jobId}/retry`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'seunghye' }),
    });
    expect(retried.status).toBe(200);
    const body = (await retried.json()) as { ok: boolean; state: string };
    expect(body).toMatchObject({ ok: true, state: 'waiting' });

    const dlq = await fetch(`${handle.url}/v1/queue/dlq`);
    expect((await dlq.json()) as { count: number }).toMatchObject({ count: 0 });
  });

  it("잘못된 JSON 본문은 무시하고 기본 actor로 처리한다", async () => {
    const { queue, console: studioConsole, api } = build();
    const jobId = await enqueueAndFail(queue);
    handle = await startStudioServer({ console: studioConsole, api, actor: 'night-shift' });

    const response = await fetch(`${handle.url}/v1/queue/dlq/${jobId}/discard`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });

    expect(response.status).toBe(200);
    expect(await queue.get(jobId)).toBeUndefined();
  });
});
