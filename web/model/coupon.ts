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

export const CONTENT_REF = 'reel_kitchen_1120';
const APP_SECRET = 'demo-app-secret';
const SIGNING_KEY = 'demo-signing-key';

/**
 * 게시물 단위 규칙.
 *
 * 실제 인스타 댓글 캠페인은 "계정"이 아니라 **게시물 하나**에 걸린다. 같은 계정의 다른
 * 릴스에 단 댓글이 쿠폰을 받으면 안 되기 때문에, 웹훅의 `media.id`가 campaign.contentRef와
 * 일치할 때만 발송한다. 이 화면의 게시물 목록은 그 단위를 눈에 보이게 만든 것이다.
 */
export interface PostItem {
  id: string;
  kind: 'reel' | 'feed';
  productType: 'REELS' | 'FEED';
  title: string;
  postedLabel: string;
  views: number;
  comments: number;
}

export const POSTS: PostItem[] = [
  {
    id: CONTENT_REF,
    kind: 'reel',
    productType: 'REELS',
    title: '3평 주방 수납, 사기 전에 버리는 순서',
    postedLabel: '11월 20일',
    views: 12_800,
    comments: 96,
  },
  {
    id: 'reel_commute_1118',
    kind: 'reel',
    productType: 'REELS',
    title: '퇴사 후 첫 달, 돈 새는 곳 3군데',
    postedLabel: '11월 18일',
    views: 8_400,
    comments: 61,
  },
  {
    id: 'feed_cafe_1115',
    kind: 'feed',
    productType: 'FEED',
    title: '부산 전포 카페 6곳 저장용',
    postedLabel: '11월 15일',
    views: 5_300,
    comments: 28,
  },
];

export interface CouponRule {
  keywords: string[];
  rewardAmount: number;
  claimLimit: number;
  tokenTtlMinutes: number;
  /** 팔로워가 확인된 댓글에만 DM을 보낸다. */
  followerOnly: boolean;
  /** 같은 게시물의 DM을 몇 초 간격으로 보낼지(0 = 즉시). */
  sendIntervalSeconds: number;
}

export const DEFAULT_RULE: CouponRule = {
  keywords: ['쿠폰', '할인', '링크'],
  rewardAmount: 5_000,
  claimLimit: 100,
  tokenTtlMinutes: 15,
  followerOnly: false,
  sendIntervalSeconds: 0,
};

export const SEND_INTERVAL_PRESETS = [0, 3, 10, 30] as const;

export const REWARD_PRESETS = [3_000, 5_000, 10_000] as const;

export function rewardLabelOf(amount: number): string {
  return `${amount.toLocaleString('ko-KR')}원 쿠폰`;
}

export function campaignFrom(post: PostItem, rule: CouponRule, nowMs: number): InteractiveCampaign {
  return {
    id: 1,
    tenantId: 1,
    code: `DROP-${post.id.slice(-4).toUpperCase()}`,
    platform: 'instagram',
    contentRef: post.id,
    triggerKeywords: [...rule.keywords],
    rewardLabel: rewardLabelOf(rule.rewardAmount),
    rewardAmount: rule.rewardAmount,
    claimLimit: rule.claimLimit,
    totalRewardBudget: rule.rewardAmount * rule.claimLimit,
    tokenTtlMinutes: rule.tokenTtlMinutes,
    startsAt: nowMs - 3_600_000,
    endsAt: nowMs + 6 * 3_600_000,
    status: 'live',
    followerOnly: rule.followerOnly,
    sendIntervalSeconds: rule.sendIntervalSeconds,
  };
}

export const CAMPAIGN: InteractiveCampaign = campaignFrom(POSTS[0]!, DEFAULT_RULE, Date.now());

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

  campaign: InteractiveCampaign;

  rule: CouponRule;

  post: PostItem;

  feed: FeedItem[] = [];

  dms: DmRecord[] = [];

  deadLetters: DeadLetterView[] = [];

  ingest: IngestReport = {
    received: 0,
    accepted: 0,
    enqueued: 0,
    ignored: 0,
    duplicates: 0,
    abuseBlocked: 0,
    noSignature: 0,
    nonFollower: 0,
  };

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
    this.rule = { ...DEFAULT_RULE };
    this.post = POSTS[0]!;
    this.campaign = campaignFrom(this.post, this.rule, this.now());
    this.dispatcher = this.createDispatcher();
  }

  private createDispatcher(): InteractiveCouponDispatcher {
    const now = this.now;
    return new InteractiveCouponDispatcher({
      campaigns: [this.campaign],
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

  /**
   * 게시물 또는 규칙을 바꿔 새 드롭을 시작한다.
   * 규칙이 바뀌면 예산·장수·보상이 달라지므로 이전 시험 기록을 새 규칙에 섞지 않는다.
   */
  applyRule(post: PostItem, rule: CouponRule): void {
    this.post = post;
    this.rule = { ...rule, keywords: [...rule.keywords] };
    this.campaign = campaignFrom(post, this.rule, this.now());
    this.feed = [];
    this.dms = [];
    this.deadLetters = [];
    this.pendingTokens.clear();
    this.ingest = {
      received: 0,
      accepted: 0,
      enqueued: 0,
      ignored: 0,
      duplicates: 0,
      abuseBlocked: 0,
      noSignature: 0,
      nonFollower: 0,
    };
    this.dispatch = { claimed: 0, dispatched: 0, retried: 0, deadLettered: 0, late: 0, slaCompliance: 1, worstLatencyMs: 0 };
    this.storm = null;
    this.dispatcher = this.createDispatcher();
  }

  reset(): void {
    this.feed = [];
    this.dms = [];
    this.deadLetters = [];
    this.pendingTokens.clear();
    this.ingest = {
      received: 0,
      accepted: 0,
      enqueued: 0,
      ignored: 0,
      duplicates: 0,
      abuseBlocked: 0,
      noSignature: 0,
      nonFollower: 0,
    };
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
  buildWebhook(
    text: string,
    authorRef: string,
    handle: string,
    isFollower: boolean | null = null,
  ): { body: string; header: string; payload: unknown } {
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
                from: { id: authorRef, username: handle, is_follower: isFollower },
                // The media id is what binds a comment to one post's rule.
                media: { id: this.post.id, media_product_type: this.post.productType },
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
  async submitComment(input: {
    text: string;
    handle?: string;
    reuseAuthor?: boolean;
    newAccount?: boolean;
    /** 이 데모 댓글 작성자가 팔로워인지. 비우면 '모름'(null). */
    isFollower?: boolean | null;
  }): Promise<void> {
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

    const { body, header, payload } = this.buildWebhook(input.text, authorRef, handle, input.isFollower ?? null);
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
      nonFollower: this.ingest.nonFollower + report.nonFollower,
    };

    if (report.abuseBlocked > 0) {
      this.push({
        at,
        kind: 'blocked',
        handle,
        text: input.text,
        detail: '같은 계정이 짧은 시간에 반복해 도배로 판단했습니다. 발급하지 않고 예산도 쓰지 않았습니다.',
      });
    } else if (report.duplicates > 0) {
      this.push({ at, kind: 'duplicate', handle, text: input.text, detail: '같은 댓글이 다시 들어와 한 번만 처리했습니다.' });
    } else if (report.nonFollower > 0) {
      this.push({
        at,
        kind: 'ignored',
        handle,
        text: input.text,
        detail: '팔로워가 확인되지 않아 보내지 않았습니다. 팔로워 전용 규칙에서는 확인된 사람에게만 DM이 갑니다.',
      });
    } else if (report.ignored > 0) {
      this.push({
        at,
        kind: 'ignored',
        handle,
        text: input.text,
        detail: '자동응답 키워드가 없어 지나갔습니다.',
      });
    } else {
      this.push({ at, kind: 'comment', handle, text: input.text, detail: '서명 확인을 통과해 발송 대기열에 넣었습니다.' });
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
          detail: '5초 안에 보내지 못해 취소했습니다. 늦은 쿠폰은 보내지 않습니다.',
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
          expiresAt: pending.at + this.campaign.tokenTtlMinutes * 60_000,
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
          detail: `1회용 링크를 보냈습니다. ${this.campaign.tokenTtlMinutes}분 안에 한 번만 사용할 수 있고, 남은 쿠폰은 ${this.poolRemaining}장입니다.`,
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
    this.dispatcher.recordClick(this.campaign.id, dm.tokenUuid);
    const outcome = await this.dispatcher.claim(dm.plainToken);
    this.dms = this.dms.map((item) =>
      item.jobId === jobId ? { ...item, claimed: outcome.status === 'GRANTED' || item.claimed, claimStatus: outcome.status } : item,
    );
    return outcome;
  }

  recordPurchase(jobId: number, orderAmount: number): void {
    const dm = this.dms.find((item) => item.jobId === jobId);
    if (!dm || !dm.claimed) return;
    this.dispatcher.recordPurchase(this.campaign.id, dm.tokenUuid, `order_${jobId}`, orderAmount);
    this.dms = this.dms.map((item) => (item.jobId === jobId ? { ...item, purchased: true } : item));
  }

  funnel(): FunnelReport {
    return this.dispatcher.funnel(this.campaign.id);
  }

  get poolRemaining(): number {
    return this.dispatcher.pool(this.campaign.id)?.remaining ?? 0;
  }

  get poolGranted(): number {
    return this.dispatcher.pool(this.campaign.id)?.granted ?? 0;
  }

  jobs(): DispatchJob[] {
    return this.dispatcher.jobsSnapshot();
  }

  async runStorm(comments = 1_000): Promise<StormReport> {
    this.storm = await this.dispatcher.simulateCommentStorm({ comments, abuseRate: 0.06, clickRate: 0.6, seed: 20261114 });
    return this.storm;
  }
}
