import type { JobQueue } from '../../lib/queue/jobQueue';
import type { JobState, QueueJob } from '../../types/queue';

/**
 * DLQ operator actions — one-click retry / discard.
 *
 * Why a service instead of calling the queue from the API handler
 * ---------------------------------------------------------------
 * "Requeue this failed render" is a destructive, auditable action, not a REST
 * detail. Three things must happen together and none of them may be skipped:
 *
 *   1. state check — only dlq/failed jobs may be replayed or discarded, so an
 *      accidental click cannot resurrect an active or completed job;
 *   2. the queue transition (replay resets attempts/progress, discard removes
 *      the row) with its event;
 *   3. an operator record — who asked, when, what happened, and why it was
 *      refused. A dashboard that mutates state without leaving that trail is
 *      unauditable the moment two people use it.
 *
 * The HTTP handler, the HTML console buttons and the CLI all call this service,
 * so the rule lives in exactly one place.
 */

export type DlqAction = 'retry' | 'discard';

export interface DlqActionRecord {
  at: string;
  actor: string;
  action: DlqAction;
  jobId: string;
  /** applied = the queue changed; rejected = nothing changed */
  outcome: 'applied' | 'rejected';
  detail: string;
}

export interface DlqActionOutcome {
  /** HTTP-ish status so the API layer stays a thin adapter */
  status: 200 | 404 | 409;
  ok: boolean;
  action: DlqAction;
  jobId: string;
  /** State after the action. `discarded` is terminal for the API, not a queue state. */
  state?: JobState | 'discarded';
  message: string;
  at: string;
}

export interface DlqActionServiceOptions {
  queue: JobQueue;
  now?: () => number;
  /** Kept operator records in memory; enough for a dashboard, replaced by a DB in production. */
  maxRecords?: number;
}

const DEFAULT_MAX_RECORDS = 100;

export class DlqActionService {
  private readonly queue: JobQueue;
  private readonly now: () => number;
  private readonly maxRecords: number;
  private readonly records: DlqActionRecord[] = [];

  constructor(options: DlqActionServiceOptions) {
    this.queue = options.queue;
    this.now = options.now ?? Date.now;
    this.maxRecords = Math.max(1, options.maxRecords ?? DEFAULT_MAX_RECORDS);
  }

  /** Most recent first — the console shows the last few operations. */
  recent(count = 10): DlqActionRecord[] {
    return this.records.slice(-Math.max(0, count)).reverse();
  }

  get size(): number {
    return this.records.length;
  }

  retry(jobId: string, actor = 'operator'): Promise<DlqActionOutcome> {
    return this.run('retry', jobId, actor);
  }

  discard(jobId: string, actor = 'operator'): Promise<DlqActionOutcome> {
    return this.run('discard', jobId, actor);
  }

  private async run(action: DlqAction, jobId: string, actor: string): Promise<DlqActionOutcome> {
    const at = new Date(this.now()).toISOString();
    const id = (jobId ?? '').trim();
    const who = (actor ?? '').trim() || 'operator';

    if (id === '') {
      return this.reject(action, id, who, at, 404, 'jobId가 비어 있습니다.');
    }

    const job = await this.queue.get(id);
    if (!job) {
      return this.reject(action, id, who, at, 404, `작업 ${id}을(를) 찾을 수 없습니다. 이미 폐기되었을 수 있습니다.`);
    }

    const eligible = job.state === 'dlq' || job.state === 'failed';
    if (!eligible) {
      return this.reject(
        action,
        id,
        who,
        at,
        409,
        `작업 상태가 ${job.state}입니다. DLQ 또는 실패 상태의 작업만 ${action === 'retry' ? '재시도' : '폐기'}할 수 있습니다.`,
      );
    }

    try {
      const updated: QueueJob = action === 'retry' ? await this.queue.replay(id) : await this.queue.discard(id, `discarded by ${who}`);
      const state: JobState | 'discarded' = action === 'retry' ? updated.state : 'discarded';
      const message =
        action === 'retry'
          ? `작업 ${id}을(를) 대기열에 다시 넣었습니다(시도 횟수 초기화).`
          : `작업 ${id}을(를) DLQ에서 폐기했습니다. 이벤트 로그에 사유가 남습니다.`;
      this.record({ at, actor: who, action, jobId: id, outcome: 'applied', detail: message });
      return { status: 200, ok: true, action, jobId: id, state, message, at };
    } catch (error) {
      const message = error instanceof Error ? error.message : '알 수 없는 오류';
      this.record({ at, actor: who, action, jobId: id, outcome: 'rejected', detail: message });
      return { status: 409, ok: false, action, jobId: id, state: job.state, message, at };
    }
  }

  private reject(action: DlqAction, jobId: string, actor: string, at: string, status: 404 | 409, message: string): DlqActionOutcome {
    this.record({ at, actor, action, jobId, outcome: 'rejected', detail: message });
    return { status, ok: false, action, jobId, state: undefined, message, at };
  }

  private record(entry: DlqActionRecord): void {
    this.records.push(entry);
    if (this.records.length > this.maxRecords) this.records.splice(0, this.records.length - this.maxRecords);
  }
}
