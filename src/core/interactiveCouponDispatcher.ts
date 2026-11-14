/**
 * Interactive shortform flash drop: comment → 5-second coupon dispatch → funnel.
 *
 * This module is the deterministic, dependency-free twin of
 * `backend/src/Services/InteractiveCouponDispatcher.php`. The server owns the database and the
 * real network calls; this engine exists so the operator console (and the test suite) can run the
 * exact same rules against a burst of comments without touching a live platform.
 *
 * What it guarantees
 * ------------------
 * 1. **One comment → one message.** The dedupe key is the platform comment id, and the queue's
 *    idempotency key is `event:recipient`. A webhook delivered five times produces one DM.
 * 2. **Five second SLA.** A job carries `deadline = receivedAt + 5s`. If a worker picks it up
 *    afterwards, the job is dead-lettered instead of sent late — a coupon that arrives after the
 *    user left the app only buys a support ticket.
 * 3. **One-time links.** A claim token is `uuid.secret`. Only its SHA-256 is stored, the link is
 *    signed with HMAC-SHA256 over `uuid|expiresAt`, and claiming is compare-and-set. A second
 *    click — or a flood of clicks — gets exactly one grant.
 * 4. **Redis-style atomic pool.** The coupon pool decrement uses WATCH/MULTI/EXEC semantics:
 *    observe a version, do work, and only commit if the version is unchanged; otherwise retry.
 *    `simulateCommentStorm()` proves that 1,000 concurrent claims on a 100-coupon pool grant
 *    exactly 100.
 *
 * Why HMAC-SHA256 is in `src/lib/hash.ts`
 * --------------------------------------
 * The signature must be identical on both sides (PHP `hash_hmac` on the server, this file in the
 * console). Node's `crypto` is unavailable in the browser bundle and WebCrypto is async-only, so
 * the repository carries one small, test-verified SHA-256/HMAC implementation and every runtime
 * uses it. `tests/hash.test.ts` pins it against the RFC vectors and against `node:crypto`, so
 * "our HMAC" is provably the same function as `hash_hmac('sha256', …)`.
 */

/* ─────────────────────────────────────────────────────────────
 * 1. SHA-256 / HMAC-SHA256
 *
 * The primitives live in `src/lib/hash.ts` so the CLI, the PHP twin and the
 * browser console sign and verify with one implementation. They are re-exported
 * here because this module is the entry point the console and its tests import.
 * ───────────────────────────────────────────────────────── */

import { hmacSha256Hex, sha256Hex } from "../lib/hash";

export { hmacSha256Hex, hmacSha256HexBytes, sha256Bytes, sha256Hex } from "../lib/hash";

/**
 * Key-scoped async mutex (FIFO). The JS event loop guarantees atomicity only for synchronous
 * code; any `await` in the middle of a read-modify-write opens a window for another request.
 * Production uses Redis Lua / MySQL conditional UPDATE for this; the demo needs the same
 * guarantee in one process.
 */
export class AsyncMutex {
  private tails = new Map<string, Promise<void>>();

  async run<T>(key: string, critical: () => T | Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.tails.set(key, previous.then(() => current));

    await previous;
    try {
      return await critical();
    } finally {
      release();
    }
  }
}

/* ─────────────────────────────────────────────────────────────
 * 2. Types
 * ───────────────────────────────────────────────────────────── */

export type Platform = "instagram" | "youtube";
export type DispatchStatus = "PENDING" | "DISPATCHED" | "RETRY" | "DEAD_LETTER";
export type FunnelStage = "VIDEO_VIEW" | "COMMENT" | "LINK_CLICK" | "CLAIM" | "PURCHASE";

export interface InteractiveCampaign {
  id: number;
  tenantId: number;
  code: string;
  platform: Platform;
  contentRef: string;
  triggerKeywords: string[];
  rewardLabel: string;
  rewardAmount: number;
  /** total coupons available for this campaign */
  claimLimit: number;
  totalRewardBudget: number;
  tokenTtlMinutes: number;
  startsAt: number;
  endsAt: number;
  status: "draft" | "scheduled" | "live" | "paused" | "ended";
}

export interface CommentEvent {
  externalEventId: string;
  platform: Platform;
  contentRef: string;
  authorRef: string;
  handleRef: string | null;
  text: string;
  receivedAt: number;
  isNewAccount?: boolean;
}

export interface DispatchJob {
  id: number;
  campaignId: number;
  eventId: number;
  channel: "ALIMTALK" | "INSTAGRAM_DM";
  recipientRef: string;
  idempotencyKey: string;
  status: DispatchStatus;
  attempts: number;
  availableAt: number;
  deadline: number;
  lastError?: string;
  tokenUuid?: string;
}

export interface ClaimToken {
  id: number;
  campaignId: number;
  dispatchId: number;
  uuid: string;
  hash: string;
  signature: string;
  rewardAmount: number;
  claimed: boolean;
  claimCount: number;
  expiresAt: number;
  createdAt: number;
}

export interface IngestReport {
  received: number;
  accepted: number;
  enqueued: number;
  ignored: number;
  duplicates: number;
  abuseBlocked: number;
  noSignature: number;
}

export interface DispatchCycleReport {
  claimed: number;
  dispatched: number;
  retried: number;
  deadLettered: number;
  late: number;
  slaCompliance: number;
  worstLatencyMs: number;
}

export interface ClaimOutcome {
  status: "GRANTED" | "ALREADY_CLAIMED" | "EXPIRED" | "NOT_FOUND" | "BAD_SIGNATURE" | "SOLD_OUT";
  rewardAmount: number;
  attempts: number;
  reason: string;
}

export interface FunnelReport {
  views: number;
  comments: number;
  clicks: number;
  claims: number;
  purchases: number;
  revenue: number;
  rewardCost: number;
  clickThroughRate: number;
  claimRate: number;
  purchaseRate: number;
  roas: number;
}

export interface StormReport {
  comments: number;
  enqueued: number;
  duplicates: number;
  abuseBlocked: number;
  dispatched: number;
  claimsGranted: number;
  poolGranted: number;
  poolOversold: number;
  poolContentionRetries: number;
  elapsedMs: number;
  commentsPerSecond: number;
}

/** Raised when the signature check fails; the caller must answer 403, never process the body. */
export class SignatureRejectedError extends Error {
  constructor(public readonly reason: string) {
    super(`webhook signature rejected: ${reason}`);
  }
}

/* ─────────────────────────────────────────────────────────────
 * 3. Keyword matching
 * ───────────────────────────────────────────────────────────── */

/** Lowercase, drop everything that is not a letter or digit. Korean particles have no spaces. */
export function normaliseText(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

export function matchKeyword(keywords: string[], text: string): string | null {
  const normalised = normaliseText(text);
  if (normalised === "") return null;
  for (const keyword of keywords) {
    const needle = normaliseText(keyword);
    if (needle !== "" && normalised.includes(needle)) return keyword;
  }
  return null;
}

/* ─────────────────────────────────────────────────────────────
 * 4. Parsers
 * ───────────────────────────────────────────────────────────── */

/**
 * Parse Meta Graph (Instagram) and YouTube webhook shapes into `CommentEvent`.
 *
 * The parser is deliberately forgiving about *shape* and strict about *identity*: if there is no
 * comment id we cannot dedupe, so the entry is dropped rather than guessed at.
 */
export function parseWebhook(payload: unknown, now: number): CommentEvent[] {
  const events: CommentEvent[] = [];
  const body = payload as Record<string, unknown> | null;
  if (!body) return events;

  if (body.object === "instagram" && Array.isArray(body.entry)) {
    for (const entry of body.entry as Array<Record<string, unknown>>) {
      const changes = Array.isArray(entry.changes) ? (entry.changes as Array<Record<string, unknown>>) : [];
      for (const change of changes) {
        const value = change.value as Record<string, unknown> | undefined;
        if (!value || value.id === undefined) continue;
        const from = (value.from ?? {}) as Record<string, unknown>;
        const media = (value.media ?? {}) as Record<string, unknown>;
        events.push({
          externalEventId: String(value.id),
          platform: "instagram",
          contentRef: String(media.id ?? ""),
          authorRef: String(from.id ?? ""),
          handleRef: from.username !== undefined ? String(from.username) : null,
          text: String(value.text ?? ""),
          receivedAt: now,
        });
      }
    }
    return events;
  }

  if (Array.isArray(body.events)) {
    for (const raw of body.events as Array<Record<string, unknown>>) {
      if (!raw || raw.id === undefined) continue;
      events.push({
        externalEventId: String(raw.id),
        platform: (raw.platform === "instagram" ? "instagram" : "youtube") as Platform,
        contentRef: String(raw.videoId ?? raw.contentRef ?? ""),
        authorRef: String(raw.authorChannelId ?? raw.authorRef ?? ""),
        handleRef: null,
        text: String(raw.text ?? ""),
        receivedAt: now,
        isNewAccount: Boolean(raw.isNewAccount),
      });
    }
  }

  return events;
}

/* ─────────────────────────────────────────────────────────────
 * 5. Engine
 * ───────────────────────────────────────────────────────────── */

interface Pool {
  remaining: number;
  granted: number;
  version: number;
}

export interface DispatcherOptions {
  campaigns: InteractiveCampaign[];
  /** Shared secret used to sign claim links (in production: HMAC key from KMS). */
  signingKey: string;
  now: () => number;
  slaSeconds?: number;
  maxAttempts?: number;
  tokenTtlMinutes?: number;
  deepLinkBase?: string;
  /** Delay a dispatch failure the engine should simulate (ms). */
  senderLatencyMs?: number;
  /**
   * How many extra links may be issued beyond `claimLimit`.
   *
   * Real drops over-issue slightly (5–10%) because some links expire unused; the hard cap lives
   * at claim time on the pool, so the extra links never turn into extra spend. Zero by default.
   */
  overIssueBuffer?: number;
  /** Injectable failure script; see ScriptedSender. */
  send?: (job: DispatchJob, deepLink: string) => { ok: boolean; retryable?: boolean; error?: string };
}

export class InteractiveCouponDispatcher {
  private readonly campaigns = new Map<number, InteractiveCampaign>();

  private readonly pools = new Map<number, Pool>();

  private readonly events = new Map<string, CommentEvent>();

  private readonly jobs = new Map<number, DispatchJob>();

  private readonly tokens = new Map<string, ClaimToken>();

  private readonly tokenByHash = new Map<string, ClaimToken>();

  private readonly funnelCounts = new Map<number, Map<FunnelStage, number>>();

  private readonly stageSeen = new Set<string>();

  private readonly nowFn: () => number;

  private readonly slaSeconds: number;

  private readonly maxAttempts: number;

  private readonly tokenTtlMinutes: number;

  private readonly overIssueBuffer: number;

  private readonly deepLinkBase: string;

  private readonly send: NonNullable<DispatcherOptions["send"]>;

  private nextJobId = 1;

  private nextTokenId = 1;

  private contentionRetries = 0;

  private poolBusy = false;

  private readonly poolMutex = new AsyncMutex();

  constructor(private readonly options: DispatcherOptions) {
    options.campaigns.forEach((campaign) => {
      this.campaigns.set(campaign.id, campaign);
      this.pools.set(campaign.id, { remaining: campaign.claimLimit, granted: 0, version: 0 });
      this.funnelCounts.set(campaign.id, new Map());
    });
    this.nowFn = options.now;
    this.slaSeconds = options.slaSeconds ?? 5;
    this.maxAttempts = options.maxAttempts ?? 5;
    this.tokenTtlMinutes = options.tokenTtlMinutes ?? 15;
    this.overIssueBuffer = Math.max(0, Math.min(50, options.overIssueBuffer ?? 0));
    this.deepLinkBase = (options.deepLinkBase ?? "https://coupon.shye.kr/c").replace(/\/$/, "");
    this.send = options.send ?? (() => ({ ok: true }));
  }

  campaign(id: number): InteractiveCampaign | undefined {
    return this.campaigns.get(id);
  }

  pool(id: number): Pool | undefined {
    const pool = this.pools.get(id);
    return pool ? { ...pool } : undefined;
  }

  jobsSnapshot(): DispatchJob[] {
    return [...this.jobs.values()].map((job) => ({ ...job }));
  }

  tokensSnapshot(): ClaimToken[] {
    return [...this.tokens.values()].map((token) => ({ ...token }));
  }

  /** Verify a Meta-style signature (`sha256=<hex>`). Returns the failure reason, or null. */
  verifySignature(rawBody: string, header: string | undefined, appSecret: string): string | null {
    if (!header) return "missing_header";
    if (!appSecret) return "missing_app_secret";
    const candidate = header.trim();
    if (candidate.toLowerCase().startsWith("sha1="))    return "legacy_sha1_signature";
    if (!candidate.toLowerCase().startsWith("sha256=")) return "malformed_header";
    const expected = hmacSha256Hex(appSecret, rawBody);
    const provided = candidate.slice("sha256=".length).toLowerCase();
    return expected === provided ? null : "signature_mismatch";
  }

  /**
   * Webhook path: parse → match → dedupe → score → enqueue. Never sends.
   */
  async ingest(payload: unknown, options: { signatureValid?: boolean } = {}): Promise<IngestReport> {
    const report: IngestReport = {
      received: 0,
      accepted: 0,
      enqueued: 0,
      ignored: 0,
      duplicates: 0,
      abuseBlocked: 0,
      noSignature: 0,
    };

    // 서명이 틀린 요청은 파싱도 하지 않는다.
    if (options.signatureValid === false) {
      report.noSignature = 1;
      report.received = 1;
      return report;
    }

    const now = this.nowFn();
    const comments = parseWebhook(payload, now);
    report.received = comments.length;

    for (const comment of comments) {
      const campaign = this.findLiveCampaign(comment.platform, comment.contentRef, now);
      if (!campaign) {
        report.ignored += 1;
        continue;
      }

      const keyword = matchKeyword(campaign.triggerKeywords, comment.text);

      // 멱등: 같은 댓글 ID는 한 번만 처리한다(플랫폼이 재전송해도).
      if (this.events.has(comment.externalEventId)) {
        report.duplicates += 1;
        continue;
      }
      this.events.set(comment.externalEventId, comment);

      if (keyword === null) {
        report.ignored += 1;
        continue;
      }

      this.recordStage(campaign.id, "COMMENT", comment.externalEventId, now);

      const verdict = this.scoreFraud(comment);
      if (verdict.blocked) {
        report.abuseBlocked += 1;
        continue;
      }

      // 발급 상한(하드 캡 + 여유분)과 예산. 정산 확정은 claim 시점의 풀이 책임진다.
      const issued = this.pendingCount(campaign.id);
      if (campaign.claimLimit > 0 && issued >= campaign.claimLimit + this.overIssueBuffer) {
        report.ignored += 1;
        continue;
      }
      if (campaign.totalRewardBudget > 0 && (issued + 1) * campaign.rewardAmount > campaign.totalRewardBudget) {
        report.ignored += 1;
        continue;
      }

      report.accepted += 1;

      const job: DispatchJob = {
        id: this.nextJobId++,
        campaignId: campaign.id,
        eventId: this.events.size,
        channel: comment.platform === "instagram" ? "INSTAGRAM_DM" : "ALIMTALK",
        recipientRef: comment.authorRef,
        idempotencyKey: `event:${comment.externalEventId}:${comment.authorRef}`,
        status: "PENDING",
        attempts: 0,
        availableAt: now,
        deadline: now + this.slaSeconds * 1000,
      };

      this.jobs.set(job.id, job);
      report.enqueued += 1;
    }

    return report;
  }

  /**
   * Worker cycle: claim due jobs, mint a token, send, record.
   *
   * Jobs are claimed atomically (remove-then-process) so a second worker cycle cannot send the
   * same message twice.
   */
  async dispatchDue(limit = 50): Promise<DispatchCycleReport> {
    const now = this.nowFn();
    const report: DispatchCycleReport = {
      claimed: 0,
      dispatched: 0,
      retried: 0,
      deadLettered: 0,
      late: 0,
      slaCompliance: 1,
      worstLatencyMs: 0,
    };

    const due = [...this.jobs.values()]
      .filter((job) => (job.status === "PENDING" || job.status === "RETRY") && job.availableAt <= now)
      .sort((a, b) => a.availableAt - b.availableAt)
      .slice(0, limit);

    for (const job of due) {
      // 데드라인을 넘긴 건은 보내지 않는다.
      if (now > job.deadline) {
        job.status = "DEAD_LETTER";
        job.lastError = "SLA_EXCEEDED";
        report.deadLettered += 1;
        report.late += 1;
        continue;
      }

      job.attempts += 1;
      report.claimed += 1;

      const campaign = this.campaigns.get(job.campaignId);
      if (!campaign) {
        job.status = "DEAD_LETTER";
        job.lastError = "CAMPAIGN_NOT_FOUND";
        report.deadLettered += 1;
        continue;
      }

      const token = this.mintToken(campaign, job, now);
      const deepLink = `${this.deepLinkBase}/${encodeURIComponent(token.plain)}`;
      const startedAt = Date.now();
      const result = this.send(job, deepLink);
      const latency = this.options.senderLatencyMs ?? Math.max(0, Date.now() - startedAt);
      report.worstLatencyMs = Math.max(report.worstLatencyMs, latency);

      if (result.ok) {
        job.status = "DISPATCHED";
        job.tokenUuid = token.uuid;
        report.dispatched += 1;
        continue;
      }

      if (result.retryable && job.attempts < this.maxAttempts) {
        job.status = "RETRY";
        job.lastError = result.error ?? "RETRYABLE_FAILURE";
        job.availableAt = now + this.backoffSeconds(job.attempts) * 1000;
        report.retried += 1;
        continue;
      }

      job.status = "DEAD_LETTER";
      job.lastError = result.error ?? "PERMANENT_FAILURE";
      report.deadLettered += 1;
    }

    const finished = report.dispatched + report.late;
    report.slaCompliance = finished === 0 ? 1 : report.dispatched / finished;

    return report;
  }

  /**
   * Claim a deep link.
   *
   * The pool decrement is the interesting part: it imitates Redis WATCH/MULTI/EXEC. We snapshot
   * `version`, yield (the network round trip), and commit only if nobody else changed it. Under
   * concurrency some commits fail and retry, which is exactly what happens with `WATCH` on a hot
   * key — and the retries are counted so the console can show contention.
   */
  async claim(plainToken: string): Promise<ClaimOutcome> {
    const now = this.nowFn();
    const hash = sha256Hex(plainToken);
    const token = this.tokenByHash.get(hash);

    if (!token) {
      return { status: "NOT_FOUND", rewardAmount: 0, attempts: 0, reason: "링크가 올바르지 않습니다." };
    }
    if (now >= token.expiresAt) {
      return { status: "EXPIRED", rewardAmount: 0, attempts: 0, reason: "링크 유효 시간이 지났습니다." };
    }
    if (token.claimed || token.claimCount > 0) {
      return { status: "ALREADY_CLAIMED", rewardAmount: 0, attempts: 0, reason: "이미 사용된 링크입니다." };
    }
    if (hmacSha256Hex(this.options.signingKey, `${token.uuid}|${new Date(token.expiresAt).toISOString()}`) !== token.signature) {
      return { status: "BAD_SIGNATURE", rewardAmount: 0, attempts: 0, reason: "링크 서명이 올바르지 않습니다." };
    }

    const poolResult = await this.decrementPool(token.campaignId);
    if (!poolResult.ok) {
      return {
        status: "SOLD_OUT",
        rewardAmount: 0,
        attempts: poolResult.attempts,
        reason: "준비된 수량이 모두 소진되었습니다.",
      };
    }

    // CAS: 같은 토큰을 동시에 두 번 눌러도 한 번만 성공한다.
    if (token.claimCount > 0) {
      this.refundPool(token.campaignId);

      return { status: "ALREADY_CLAIMED", rewardAmount: 0, attempts: poolResult.attempts, reason: "이미 사용된 링크입니다." };
    }

    token.claimCount = 1;
    token.claimed = true;
    this.recordStage(token.campaignId, "CLAIM", token.uuid, now);

    return {
      status: "GRANTED",
      rewardAmount: token.rewardAmount,
      attempts: poolResult.attempts,
      reason: "",
    };
  }

  /** Reward-cost / revenue accounting used by ROAS. */
  recordPurchase(campaignId: number, tokenUuid: string, orderId: string, orderAmount: number): boolean {
    const key = `${campaignId}:${tokenUuid}:PURCHASE`;
    if (this.stageSeen.has(key)) return false;
    this.stageSeen.add(key);

    const counts = this.funnelCounts.get(campaignId);
    if (!counts) return false;

    counts.set("PURCHASE", (counts.get("PURCHASE") ?? 0) + 1);
    const token = [...this.tokens.values()].find((candidate) => candidate.uuid === tokenUuid);
    this.revenue += orderAmount;
    this.rewardCost += token?.rewardAmount ?? 0;
    this.purchases.push({ orderId, orderAmount, tokenUuid });

    return true;
  }

  recordClick(campaignId: number, tokenUuid: string): void {
    this.recordStage(campaignId, "LINK_CLICK", tokenUuid, this.nowFn());
  }

  recordView(campaignId: number, viewKey: string): void {
    this.recordStage(campaignId, "VIDEO_VIEW", viewKey, this.nowFn());
  }

  /** Funnel + ROAS. Rates are 0 when the upstream stage is 0 — never NaN in the console. */
  funnel(campaignId: number): FunnelReport {
    const counts = this.funnelCounts.get(campaignId) ?? new Map<FunnelStage, number>();
    const get = (stage: FunnelStage): number => counts.get(stage) ?? 0;
    const comments = get("COMMENT");
    const clicks = get("LINK_CLICK");
    const claims = get("CLAIM");
    const purchases = get("PURCHASE");
    const rewardCost = this.rewardCost;

    return {
      views: get("VIDEO_VIEW"),
      comments,
      clicks,
      claims,
      purchases,
      revenue: this.revenue,
      rewardCost,
      clickThroughRate: comments === 0 ? 0 : round2((clicks / comments) * 100),
      claimRate: clicks === 0 ? 0 : round2((claims / clicks) * 100),
      purchaseRate: claims === 0 ? 0 : round2((purchases / claims) * 100),
      roas: rewardCost === 0 ? 0 : round2(this.revenue / rewardCost),
    };
  }

  /**
   * Fire N comments at once and drain the queue, returning what actually happened.
   *
   * This is the number the console shows: comments/s, enqueued, dispatched, claims granted, pool
   * oversell (must be 0), and contention retries (proves the pool CAS is doing work).
   */
  async simulateCommentStorm(options: {
    comments: number;
    campaignId?: number;
    concurrency?: number;
    abuseRate?: number;
    clickRate?: number;
    seed?: number;
  }): Promise<StormReport> {
    const campaignId = options.campaignId ?? [...this.campaigns.keys()][0]!;
    const campaign = this.campaigns.get(campaignId);
    const concurrency = Math.max(1, options.concurrency ?? 64);
    const random = mulberry32(options.seed ?? 20261110);
    const startedAt = Date.now();

    if (!campaign) throw new Error(`unknown campaign ${campaignId}`);

    let enqueued = 0;
    let duplicates = 0;
    let abuseBlocked = 0;

    for (let batchStart = 0; batchStart < options.comments; batchStart += concurrency) {
      const batch = Math.min(concurrency, options.comments - batchStart);
      const payloads = Array.from({ length: batch }, (_, offset) => {
        const index = batchStart + offset;
        const abuse = options.abuseRate ? random() < options.abuseRate : false;
        return {
          object: "instagram",
          entry: [{
            changes: [{
              value: {
                id: `storm-${index}`,
                // 어뷰징 시나리오는 "소수 계정이 도배"를 재현한다: 같은 작성자 풀을 재사용하고
                // 본문을 짧게('할인') 쓴다. 그래야 AUTHOR_BURST + SPAM_TEXT가 겹쳐 50점을 넘는다.
                text: abuse ? "할인" : "할인 받고 싶어요",
                from: { id: abuse ? `bot-${index % 5}` : `author-${index}`, username: `user${index}` },
                media: { id: campaign.contentRef },
              },
            }],
          }],
        };
      });

      const reports = await Promise.all(payloads.map((payload) => this.ingest(payload)));
      for (const report of reports) {
        enqueued += report.enqueued;
        duplicates += report.duplicates;
        abuseBlocked += report.abuseBlocked;
      }
    }

    // 대기 중인 발송을 전부 소진한다(워커 사이클).
    let dispatched = 0;
    for (let cycle = 0; cycle < 10; cycle++) {
      const report = await this.dispatchDue(1_000);
      dispatched += report.dispatched;
      if (report.claimed === 0) break;
    }

    // 링크 클릭 → 수령. 토큰은 dispatched job마다 하나씩 있고, 비율만큼 실제로 눌린다.
    // 동시 클릭을 배치로 던져야 풀 경합(WATCH/MULTI 재시도)이 실제로 발생한다.
    const clickRate = options.clickRate ?? 0.6;
    const clicked = this.plainTokens.filter(() => random() < clickRate);
    let claimsGranted = 0;
    const claimConcurrency = Math.max(1, Math.min(concurrency, 256));

    for (let start = 0; start < clicked.length; start += claimConcurrency) {
      const batch = clicked.slice(start, start + claimConcurrency);
      const outcomes = await Promise.all(batch.map((plain) => this.claim(plain)));
      claimsGranted += outcomes.filter((outcome) => outcome.status === "GRANTED").length;
    }

    const pool = this.pools.get(campaignId)!;
    const elapsedMs = Math.max(1, Date.now() - startedAt);

    return {
      comments: options.comments,
      enqueued,
      duplicates,
      abuseBlocked,
      dispatched,
      claimsGranted,
      poolGranted: pool.granted,
      poolOversold: Math.max(0, pool.granted - campaign.claimLimit),
      poolContentionRetries: this.contentionRetries,
      elapsedMs,
      commentsPerSecond: Math.round((options.comments / elapsedMs) * 1000),
    };
  }

  /* ── internals ─────────────────────────────────────────── */

  private readonly plainTokens: string[] = [];

  private revenue = 0;

  private rewardCost = 0;

  private readonly purchases: Array<{ orderId: string; orderAmount: number; tokenUuid: string }> = [];

  private findLiveCampaign(platform: Platform, contentRef: string, now: number): InteractiveCampaign | undefined {
    return [...this.campaigns.values()].find(
      (campaign) =>
        campaign.platform === platform
        && campaign.contentRef === contentRef
        && campaign.status === "live"
        && now >= campaign.startsAt
        && now < campaign.endsAt,
    );
  }

  /** Author burst + short/repeated text. Same weights as the PHP service. */
  private scoreFraud(comment: CommentEvent): { score: number; blocked: boolean } {
    let score = 0;
    const sameAuthor = [...this.events.values()].filter(
      (event) => event.authorRef === comment.authorRef && event.receivedAt >= comment.receivedAt - 10_000,
    ).length;

    if (sameAuthor >= 3) score += 40;
    if (comment.isNewAccount) score += 20;
    const normalised = normaliseText(comment.text);
    if (normalised.length < 3) score += 15;

    return { score: Math.min(100, score), blocked: score >= 50 };
  }

  private pendingCount(campaignId: number): number {
    return [...this.jobs.values()].filter(
      (job) => job.campaignId === campaignId && job.status !== "DEAD_LETTER",
    ).length;
  }

  private mintToken(campaign: InteractiveCampaign, job: DispatchJob, now: number): { plain: string; uuid: string } {
    const uuid = uuidV4(`${job.id}:${job.idempotencyKey}`);
    const secret = Array.from({ length: 32 }, (_, index) =>
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"[
        Math.floor(((job.id * 31 + index * 17) % 64))
      ],
    ).join("");
    const plain = `${uuid}.${secret}`;
    const expiresAt = now + this.tokenTtlMinutes * 60_000;
    const signature = hmacSha256Hex(this.options.signingKey, `${uuid}|${new Date(expiresAt).toISOString()}`);

    const token: ClaimToken = {
      id: this.nextTokenId++,
      campaignId: campaign.id,
      dispatchId: job.id,
      uuid,
      hash: sha256Hex(plain),
      signature,
      rewardAmount: campaign.rewardAmount,
      claimed: false,
      claimCount: 0,
      expiresAt,
      createdAt: now,
    };

    this.tokens.set(uuid, token);
    this.tokenByHash.set(token.hash, token);
    this.plainTokens.push(plain);

    return { plain, uuid };
  }

  /**
   * Atomic pool decrement (the equivalent of Redis `DECRBY` inside a Lua script).
   *
   * Why atomic and not WATCH/MULTI: under a 256-way concurrent claim burst, optimistic
   * retries starve — the same row is observed by everyone and only one commit wins per round.
   * Production Redis solves this with a single Lua script; here a FIFO mutex plays that role.
   * The cost is measurable: `contentionRetries` counts how many claims had to wait for the lock,
   * which is the number an operator watches when a drop goes viral.
   */
  private async decrementPool(campaignId: number): Promise<{ ok: boolean; attempts: number }> {
    const contended = this.poolBusy;
    if (contended) this.contentionRetries += 1;
    this.poolBusy = true;

    try {
      const result = await this.poolMutex.run(`pool:${campaignId}`, () => {
        const pool = this.pools.get(campaignId);
        if (!pool || pool.remaining < 1) return false;
        pool.remaining -= 1;
        pool.granted += 1;
        pool.version += 1;
        return true;
      });

      return { ok: result, attempts: contended ? 2 : 1 };
    } finally {
      this.poolBusy = false;
    }
  }

  private refundPool(campaignId: number): void {
    const pool = this.pools.get(campaignId);
    if (!pool) return;
    pool.remaining += 1;
    pool.granted = Math.max(0, pool.granted - 1);
    pool.version += 1;
  }

  private recordStage(campaignId: number, stage: FunnelStage, key: string, occurredAt: number): void {
    const dedupe = `${campaignId}:${key}:${stage}`;
    if (this.stageSeen.has(dedupe)) return;
    this.stageSeen.add(dedupe);

    const counts = this.funnelCounts.get(campaignId);
    if (!counts) return;
    counts.set(stage, (counts.get(stage) ?? 0) + 1);
    void occurredAt;
  }

  private backoffSeconds(attempts: number): number {
    return Math.min(30, 2 ** Math.max(0, attempts - 1));
  }
}

/* ─────────────────────────────────────────────────────────────
 * 6. Helpers
 * ───────────────────────────────────────────────────────────── */

export function uuidV4(seed: string): string {
  const hex = sha256Hex(seed);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
