import {
  InteractiveCouponDispatcher,
  hmacSha256Hex,
  type ClaimOutcome,
  type DispatchCycleReport,
  type DispatchJob,
  type FunnelReport,
  type IngestReport,
  type InteractiveCampaign,
  type StormReport,
} from '../../src/core/interactiveCouponDispatcher';

/**
 * Browser-side operator desk for the comment → DM → coupon flow.
 *
 * The rules are entirely `InteractiveCouponDispatcher`'s: keyword matching,
 * dedupe, abuse scoring, the 5-second deadline, HMAC-signed one-time links and
 * the atomic coupon pool. This class only gives that engine a webhook to feed,
 * a DM sender to call and a log a human can read.
 */

export const CONTENT_REF = 'reel_kitchen_1114';
const APP_SECRET = 'demo-app-secret';
const SIGNING_KEY = 'demo-signing-key';

export const CAMPAIGN: InteractiveCampaign = {
  id: 1,
  tenantId: 1,
  code: 'BUSAN-BOM-1114',
  platform: 'instagram',
  contentRef: CONTENT_REF,
  triggerKeywords: ['쿠폰', '할인', '링크'],
  rewardLabel: '5,000원 쿠폰',
  rewardAmount: 5_000,
  claimLimit: 100,
  totalRewardBudget: 500_000,
  tokenTtlMinutes: 15,
  startsAt: 0,
  endsAt: Number.MAX_SAFE_INTEGER,
  status: 'live',
};

export interface DmRecord {
  at: number;
  jobId: number;
  recipient: string;
  handle: string;
  deepLink: string;
  plainToken: string;
  tokenUuid: string;
  expiresAt: number;
  latencyMs: number;
  claimed: boolean;
  claimStatus: ClaimOutcome['status'] | null;
  purchased: boolean;
}

export type FeedKind = 'comment' | 'dm' | 'blocked' | 'ignored' | 'late' | 'duplicate';

export interface FeedItem {
  id: number;
  at: number;
  kind: FeedKind;
  handle: string;
  text: string;
  detail?: string;
  deepLink?: string;
  dmId?: number;
}

export interface DeadLetterView {
  jobId: number;
  recipient: string;
  attempts: number;
  error: string;
  deadline: number;
}

const MAX_FEED = 60;

export class CouponDesk {
  dispatcher: InteractiveCouponDispatcher;

  feed: FeedItem[] = [];

  dms: DmRecord[] = [];

  deadLetters: DeadLetterView[] = [];

  ingest: IngestReport = { received: 0, accepted: 0, enqueued: 0, ignored: 0, duplicates: 0, abuseBlocked: 0, noSignature: 0 };

  dispatch: DispatchCycleReport = {
    claimed: 0,
    dispatched: 0,
    retried: 0,
    deadLettered: 0,
    late: 0,
    slaCompliance: 1,
    worstLatencyMs: 0,
  };

  storm: StormReport | null = null;

  /** Worker pause — the way an operator proves what happens past the 5s deadline. */
  workerPaused = false;

  private readonly now: () => number;

  private seq = 0;

  private authorIndex = 1;

  private readonly handles = new Map<string, string>();

  private readonly pendingTokens = new Map<number, { plain: string; at: number; recipient: string; handle: string }>();

  constructor(now: () => number = Date.now) {
    this.now = now;
    this.dispatcher = this.createDispatcher();
  }

  private createDispatcher(): InteractiveCouponDispatcher {
    const now = this.now;
    return new InteractiveCouponDispatcher({
      campaigns: [{ ...CAMPAIGN, startsAt: now() - 3_600_000, endsAt: now() + 6 * 3_600_000 }],
      signingKey: SIGNING_KEY,
      now,
      slaSeconds: 5,
      senderLatencyMs: 38,
      // Real drops issue a few spare links; the hard cap stays at claim time.
      overIssueBuffer: 3,
      send: (job, deepLink) => {
        const plainToken = decodeURIComponent(deepLink.slice(deepLink.lastIndexOf('/') + 1));
        this.pendingTokens.set(job.id, {
          plain: plainToken,
          at: now(),
          recipient: job.recipientRef,
          handle: this.handles.get(job.recipientRef) ?? job.recipientRef,
        });
        return { ok: true };
      },
    });
  }

  reset(): void {
    this.feed = [];
    this.dms = [];
    this.deadLetters = [];
    this.pendingTokens.clear();
    this.ingest = { received: 0, accepted: 0, enqueued: 0, ignored: 0, duplicates: 0, abuseBlocked: 0, noSignature: 0 };
    this.dispatch = {
      claimed: 0,
      dispatched: 0,
      retried: 0,
      deadLettered: 0,
      late: 0,
      slaCompliance: 1,
      worstLatencyMs: 0,
    };
    this.storm = null;
    this.authorIndex = 1;
    this.dispatcher = this.createDispatcher();
  }

  private nextId(): number {
    this.seq += 1;
    return this.seq;
  }

  private push(item: Omit<FeedItem, 'id'>): FeedItem {
    const entry: FeedItem = { ...item, id: this.nextId() };
    this.feed = [entry, ...this.feed].slice(0, MAX_FEED);
    return entry;
  }

  /** Build the webhook body the platform would POST, and sign it like Meta does. */
  buildWebhook(text: string, authorRef: string, handle: string): { body: string; header: string; payload: unknown } {
    const body = JSON.stringify({
      object: 'instagram',
      entry: [
        {
          id: 'ig-entry',
          time: Math.floor(this.now() / 1000),
          changes: [
            {
              field: 'comments',
              value: {
                id: `cmt_${this.now()}_${this.seq + 1}`,
                text,
                from: { id: authorRef, username: handle },
                media: { id: CONTENT_REF, media_product_type: 'REELS' },
              },
            },
          ],
        },
      ],
    });
    return { body, header: `sha256=${hmacSha256Hex(APP_SECRET, body)}`, payload: JSON.parse(body) };
  }

  /**
   * One comment in, one webhook delivery out.
   * `reuseAuthor` reproduces the flood case: the same account commenting again.
   */
  async submitComment(input: { text: string; handle?: string; reuseAuthor?: boolean; newAccount?: boolean }): Promise<void> {
    const at = this.now();
    let authorRef: string;
    let handle: string;

    if (input.reuseAuthor && this.authorIndex > 1) {
      const existing = [...this.handles.entries()].at(-1);
      authorRef = existing?.[0] ?? 'author-1';
      handle = existing?.[1] ?? 'guri_home';
    } else {
      authorRef = `author-${this.authorIndex}`;
      handle = input.handle?.trim() || `guri_home_${this.authorIndex}`;
      this.authorIndex += 1;
      this.handles.set(authorRef, handle);
    }

    const { body, header, payload } = this.buildWebhook(input.text, authorRef, handle);
    const signatureProblem = this.dispatcher.verifySignature(body, header, APP_SECRET);
    const report = await this.dispatcher.ingest(payload, { signatureValid: signatureProblem === null });

    this.ingest = {
      received: this.ingest.received + report.received,
      accepted: this.ingest.accepted + report.accepted,
      enqueued: this.ingest.enqueued + report.enqueued,
      ignored: this.ingest.ignored + report.ignored,
      duplicates: this.ingest.duplicates + report.duplicates,
      abuseBlocked: this.ingest.abuseBlocked + report.abuseBlocked,
      noSignature: this.ingest.noSignature + report.noSignature,
    };

    if (report.abuseBlocked > 0) {
      this.push({
        at,
        kind: 'blocked',
        handle,
        text: input.text,
        detail: '어뷰징 점수 50점 이상 — 발급하지 않고 예산을 쓰지 않음',
      });
    } else if (report.duplicates > 0) {
      this.push({ at, kind: 'duplicate', handle, text: input.text, detail: '같은 댓글 ID 재전송 — 멱등키로 무시' });
    } else if (report.ignored > 0) {
      this.push({
        at,
        kind: 'ignored',
        handle,
        text: input.text,
        detail: '트리거 키워드(쿠폰·할인·링크) 불일치',
      });
    } else {
      this.push({ at, kind: 'comment', handle, text: input.text, detail: `HMAC 서명 검증 통과 · 큐 적재` });
    }
  }

  /** One worker cycle. Also records anything that slipped past the deadline. */
  async runWorkerCycle(): Promise<void> {
    if (this.workerPaused) return;
    const before = new Map(this.dispatcher.jobsSnapshot().map((job) => [job.id, job.status]));
    const report = await this.dispatcher.dispatchDue(50);

    this.dispatch = {
      claimed: this.dispatch.claimed + report.claimed,
      dispatched: this.dispatch.dispatched + report.dispatched,
      retried: this.dispatch.retried + report.retried,
      deadLettered: this.dispatch.deadLettered + report.deadLettered,
      late: this.dispatch.late + report.late,
      worstLatencyMs: Math.max(this.dispatch.worstLatencyMs, report.worstLatencyMs),
      slaCompliance: report.claimed === 0 ? this.dispatch.slaCompliance : report.slaCompliance,
    };

    const jobs = this.dispatcher.jobsSnapshot();
    for (const job of jobs) {
      if (before.get(job.id) === job.status) continue;
      if (job.status === 'DEAD_LETTER') {
        this.deadLetters = [
          { jobId: job.id, recipient: job.recipientRef, attempts: job.attempts, error: job.lastError ?? 'UNKNOWN', deadline: job.deadline },
          ...this.deadLetters,
        ].slice(0, 20);
        this.push({
          at: this.now(),
          kind: 'late',
          handle: this.handles.get(job.recipientRef) ?? job.recipientRef,
          text: '',
          detail: `5초 데드라인 초과(${job.lastError}) — 늦은 쿠폰은 보내지 않고 DLQ로`,
        });
      }
      if (job.status === 'DISPATCHED' && job.tokenUuid) {
        const pending = this.pendingTokens.get(job.id);
        if (!pending) continue;
        const dm: DmRecord = {
          at: pending.at,
          jobId: job.id,
          recipient: job.recipientRef,
          handle: pending.handle,
          deepLink: `https://coupon.shye.kr/c/${pending.plain}`,
          plainToken: pending.plain,
          tokenUuid: job.tokenUuid,
          expiresAt: pending.at + CAMPAIGN.tokenTtlMinutes * 60_000,
          latencyMs: this.dispatch.worstLatencyMs,
          claimed: false,
          claimStatus: null,
          purchased: false,
        };
        this.dms = [dm, ...this.dms].slice(0, 40);
        this.push({
          at: pending.at,
          kind: 'dm',
          handle: pending.handle,
          text: '',
          detail: `1회용 링크 발급 · 유효 15분 · 잔여 ${this.poolRemaining}장`,
          deepLink: dm.deepLink,
          dmId: dm.jobId,
        });
      }
    }
  }

  /** A click on the DM link: record the funnel stage, then try to claim. */
  async claimDm(jobId: number): Promise<ClaimOutcome> {
    const dm = this.dms.find((item) => item.jobId === jobId);
    if (!dm) {
      return { status: 'NOT_FOUND', rewardAmount: 0, attempts: 0, reason: '발급 기록이 없습니다.' };
    }
    this.dispatcher.recordClick(CAMPAIGN.id, dm.tokenUuid);
    const outcome = await this.dispatcher.claim(dm.plainToken);
    this.dms = this.dms.map((item) =>
      item.jobId === jobId ? { ...item, claimed: outcome.status === 'GRANTED' || item.claimed, claimStatus: outcome.status } : item,
    );
    return outcome;
  }

  recordPurchase(jobId: number, orderAmount: number): void {
    const dm = this.dms.find((item) => item.jobId === jobId);
    if (!dm || !dm.claimed) return;
    this.dispatcher.recordPurchase(CAMPAIGN.id, dm.tokenUuid, `order_${jobId}`, orderAmount);
    this.dms = this.dms.map((item) => (item.jobId === jobId ? { ...item, purchased: true } : item));
  }

  funnel(): FunnelReport {
    return this.dispatcher.funnel(CAMPAIGN.id);
  }

  get poolRemaining(): number {
    return this.dispatcher.pool(CAMPAIGN.id)?.remaining ?? 0;
  }

  get poolGranted(): number {
    return this.dispatcher.pool(CAMPAIGN.id)?.granted ?? 0;
  }

  jobs(): DispatchJob[] {
    return this.dispatcher.jobsSnapshot();
  }

  async runStorm(comments = 1_000): Promise<StormReport> {
    this.storm = await this.dispatcher.simulateCommentStorm({ comments, abuseRate: 0.06, clickRate: 0.6, seed: 20261114 });
    return this.storm;
  }
}
