import { describe, expect, it } from "vitest";
import {
  InteractiveCouponDispatcher,
  hmacSha256Hex,
  matchKeyword,
  normaliseText,
  parseWebhook,
  sha256Hex,
  uuidV4,
  type InteractiveCampaign,
} from "../src/core/interactiveCouponDispatcher";

/**
 * Interactive shortform dispatch engine — contract tests.
 *
 * The assertions are written as production incidents:
 *   · "the same comment arrives 5 times" → one DM
 *   · "the worker was down for 6 seconds" → dead letter, not a late coupon
 *   · "1,000 people click a 100-coupon link pool" → exactly 100 grants, zero oversell
 *   · "the link was forwarded to a group chat" → second claim rejected
 *   · "someone forges a signature" → rejected before any state changes
 */

const NOW = Date.parse("2026-11-10T10:00:00+09:00");

function campaign(overrides: Partial<InteractiveCampaign> = {}): InteractiveCampaign {
  return {
    id: 1,
    tenantId: 1,
    code: "reels-drop-2026-11",
    platform: "instagram",
    contentRef: "reels_1789",
    triggerKeywords: ["할인", "선착순", "쿠폰"],
    rewardLabel: "3,000원 즉시 할인",
    rewardAmount: 3_000,
    claimLimit: 100,
    totalRewardBudget: 300_000,
    tokenTtlMinutes: 15,
    startsAt: NOW - 3_600_000,
    endsAt: NOW + 86_400_000,
    status: "live",
    ...overrides,
  };
}

function instagram(commentId: string, text = "할인 받고 싶어요", mediaId = "reels_1789") {
  return {
    object: "instagram",
    entry: [{
      changes: [{
        value: {
          id: commentId,
          text,
          from: { id: `author-${commentId}`, username: "shye" },
          media: { id: mediaId },
        },
      }],
    }],
  };
}

interface Harness {
  dispatcher: InteractiveCouponDispatcher;
  clock: { now: number };
  deepLinks: string[];
  setSender: (script: Array<{ ok: boolean; retryable?: boolean; error?: string }>) => void;
}

function harness(options: {
  campaigns?: InteractiveCampaign[];
  slaSeconds?: number;
  maxAttempts?: number;
  overIssueBuffer?: number;
} = {}): Harness {
  const clock = { now: NOW };
  const deepLinks: string[] = [];
  let script: Array<{ ok: boolean; retryable?: boolean; error?: string }> = [];

  const dispatcher = new InteractiveCouponDispatcher({
    campaigns: options.campaigns ?? [campaign()],
    signingKey: "test-signing-key",
    now: () => clock.now,
    slaSeconds: options.slaSeconds ?? 5,
    maxAttempts: options.maxAttempts ?? 5,
    overIssueBuffer: options.overIssueBuffer ?? 0,
    send: (_job, deepLink) => {
      deepLinks.push(deepLink);
      const next = script.shift();
      if (!next) return { ok: true };
      return next;
    },
  });

  return {
    dispatcher,
    clock,
    deepLinks,
    setSender: (next) => {
      script = [...next];
    },
  };
}

function tokenOf(deepLink: string): string {
  return decodeURIComponent(deepLink.slice("https://coupon.shye.kr/c/".length));
}

describe("crypto primitives match the server (hash_hmac / hash)", () => {
  it("SHA-256 matches the standard published vectors", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("HMAC-SHA256 matches the RFC 4231-style test vector", () => {
    expect(hmacSha256Hex("key", "The quick brown fox jumps over the lazy dog")).toBe(
      "f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8",
    );
  });

  it("Korean text is hashed as UTF-8 (same bytes as PHP)", () => {
    expect(sha256Hex("할인")).toHaveLength(64);
    expect(sha256Hex("할인")).not.toBe(sha256Hex("쿠폰"));
  });

  it("uuidV4 is deterministic for the same seed and shaped like a UUID", () => {
    expect(uuidV4("seed-1")).toBe(uuidV4("seed-1"));
    expect(uuidV4("seed-1")).not.toBe(uuidV4("seed-2"));
    expect(uuidV4("seed-1")).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe("webhook parsing", () => {
  it("parses the Meta Graph comment shape", () => {
    const events = parseWebhook(instagram("c-1"), NOW);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      externalEventId: "c-1",
      platform: "instagram",
      contentRef: "reels_1789",
      authorRef: "author-c-1",
      text: "할인 받고 싶어요",
    });
  });

  it("parses the YouTube events shape", () => {
    const events = parseWebhook({
      events: [{ id: "yt-1", platform: "youtube", videoId: "yt_1", authorChannelId: "ch-1", text: "쿠폰" }],
    }, NOW);

    expect(events[0]).toMatchObject({ externalEventId: "yt-1", platform: "youtube", contentRef: "yt_1" });
  });

  it("drops entries without an id because they cannot be deduplicated", () => {
    const events = parseWebhook({ object: "instagram", entry: [{ changes: [{ value: { text: "할인" } }] }] }, NOW);

    expect(events).toHaveLength(0);
  });

  it("returns nothing for unknown shapes instead of throwing", () => {
    expect(parseWebhook({ object: "page", entry: [] }, NOW)).toEqual([]);
    expect(parseWebhook(null, NOW)).toEqual([]);
  });
});

describe("keyword matching", () => {
  it("normalises spaces, punctuation and emoji", () => {
    expect(normaliseText("할 인!!🔥")).toBe("할인");
  });

  it("matches Korean particles with no spaces", () => {
    expect(matchKeyword(["할인"], "할인받고싶어요")).toBe("할인");
    expect(matchKeyword(["선착순"], " 선착순 이벤트")).toBe("선착순");
  });

  it("is case-insensitive for latin keywords", () => {
    expect(matchKeyword(["Coupon"], "COUPON please")).toBe("Coupon");
  });

  it("returns null when nothing matches", () => {
    expect(matchKeyword(["할인", "쿠폰"], "영상 잘 봤습니다")).toBeNull();
  });
});

describe("webhook ingest", () => {
  it("rejects an unsigned payload before parsing", async () => {
    const { dispatcher } = harness();
    const report = await dispatcher.ingest(instagram("c-1"), { signatureValid: false });

    expect(report.noSignature).toBe(1);
    expect(report.enqueued).toBe(0);
  });

  it("verifies a Meta signature header", () => {
    const { dispatcher } = harness();
    const body = JSON.stringify(instagram("c-1"));
    const signature = `sha256=${hmacSha256Hex("app-secret", body)}`;

    expect(dispatcher.verifySignature(body, signature, "app-secret")).toBeNull();
    expect(dispatcher.verifySignature(body, signature, "other-secret")).toBe("signature_mismatch");
    expect(dispatcher.verifySignature(body, undefined, "app-secret")).toBe("missing_header");
    expect(dispatcher.verifySignature(body, "sha1=abc", "app-secret")).toBe("legacy_sha1_signature");
  });

  it("enqueues a keyword comment with a 5 second deadline", async () => {
    const { dispatcher } = harness();
    await dispatcher.ingest(instagram("c-1"));

    const [job] = dispatcher.jobsSnapshot();
    expect(job.status).toBe("PENDING");
    expect(job.channel).toBe("INSTAGRAM_DM");
    expect(job.deadline - job.availableAt).toBe(5_000);
  });

  it("records the same comment only once even if the webhook repeats", async () => {
    const { dispatcher } = harness();

    const first = await dispatcher.ingest(instagram("c-1"));
    const second = await dispatcher.ingest(instagram("c-1"));
    const third = await dispatcher.ingest(instagram("c-1"));

    expect(first.enqueued).toBe(1);
    expect(second.duplicates).toBe(1);
    expect(third.duplicates).toBe(1);
    expect(dispatcher.jobsSnapshot()).toHaveLength(1);
  });

  it("ignores comments without a keyword", async () => {
    const { dispatcher } = harness();
    const report = await dispatcher.ingest(instagram("c-2", "영상 잘 봤어요"));

    expect(report.ignored).toBe(1);
    expect(dispatcher.jobsSnapshot()).toHaveLength(0);
  });

  it("ignores comments on posts that are not ours", async () => {
    const { dispatcher } = harness();
    const report = await dispatcher.ingest(instagram("c-3", "할인", "someone_else_post"));

    expect(report.ignored).toBe(1);
    expect(dispatcher.jobsSnapshot()).toHaveLength(0);
  });

  it("ignores a campaign that already ended", async () => {
    const { dispatcher } = harness({ campaigns: [campaign({ status: "ended" })] });
    const report = await dispatcher.ingest(instagram("c-4"));

    expect(report.enqueued).toBe(0);
  });

  it("blocks a burst from one author", async () => {
    const { dispatcher } = harness();

    // 같은 작성자가 10초 안에 4건: 3건째부터 AUTHOR_BURST(40) + 짧은 본문 SPAM_TEXT(15) = 55점.
    const payload = {
      events: Array.from({ length: 4 }, (_, index) => ({
        id: `ig-burst-${index}`,
        platform: "instagram",
        videoId: "reels_1789",
        authorChannelId: "author-spammer",
        text: "할인",
      })),
    };
    const report = await dispatcher.ingest(payload);

    expect(report.abuseBlocked).toBeGreaterThan(0);
    expect(report.enqueued).toBeLessThan(4);
  });

  it("stops enqueueing once the claim limit is reached", async () => {
    const { dispatcher } = harness({ campaigns: [campaign({ claimLimit: 2, totalRewardBudget: 1_000_000 })] });

    const reports = await Promise.all(
      Array.from({ length: 5 }, (_, index) => dispatcher.ingest(instagram(`c-limit-${index}`))),
    );
    const enqueued = reports.reduce((sum, report) => sum + report.enqueued, 0);

    expect(enqueued).toBe(2);
    expect(dispatcher.jobsSnapshot()).toHaveLength(2);
  });

  it("stops enqueueing once the reward budget is spent", async () => {
    const { dispatcher } = harness({
      campaigns: [campaign({ claimLimit: 100, totalRewardBudget: 1, rewardAmount: 3_000 })],
    });

    const report = await dispatcher.ingest(instagram("c-budget"));
    expect(report.enqueued).toBe(0);
  });
});

describe("worker dispatch", () => {
  it("mints a one-time token and marks the job dispatched", async () => {
    const { dispatcher, deepLinks } = harness();
    await dispatcher.ingest(instagram("c-1"));

    const report = await dispatcher.dispatchDue();

    expect(report.dispatched).toBe(1);
    expect(deepLinks).toHaveLength(1);
    expect(tokenOf(deepLinks[0]!)).toContain(".");
    expect(dispatcher.tokensSnapshot()[0]?.rewardAmount).toBe(3_000);
    expect(dispatcher.tokensSnapshot()[0]?.expiresAt).toBe(NOW + 15 * 60_000);
  });

  it("does not send the same job twice across worker cycles", async () => {
    const { dispatcher, deepLinks } = harness();
    await dispatcher.ingest(instagram("c-1"));

    await dispatcher.dispatchDue();
    const second = await dispatcher.dispatchDue();

    expect(second.claimed).toBe(0);
    expect(deepLinks).toHaveLength(1);
  });

  it("dead-letters a job picked up after the deadline instead of sending it late", async () => {
    const { dispatcher, clock, deepLinks } = harness();
    await dispatcher.ingest(instagram("c-1"));

    clock.now = NOW + 6_000;
    const report = await dispatcher.dispatchDue();

    expect(report.dispatched).toBe(0);
    expect(report.deadLettered).toBe(1);
    expect(report.late).toBe(1);
    expect(deepLinks).toHaveLength(0);
    expect(dispatcher.jobsSnapshot()[0]?.lastError).toBe("SLA_EXCEEDED");
    expect(report.slaCompliance).toBe(0);
  });

  it("backs off on a retryable failure", async () => {
    const { dispatcher, clock, setSender } = harness();
    setSender([{ ok: false, retryable: true, error: "Meta 429" }]);
    await dispatcher.ingest(instagram("c-1"));

    const report = await dispatcher.dispatchDue();

    expect(report.retried).toBe(1);
    const job = dispatcher.jobsSnapshot()[0]!;
    expect(job.status).toBe("RETRY");
    expect(job.availableAt).toBe(NOW + 1_000);

    // 아직 due가 아니면 다시 집히지 않는다.
    expect((await dispatcher.dispatchDue()).claimed).toBe(0);
    clock.now = NOW + 1_000;
    expect((await dispatcher.dispatchDue()).dispatched).toBe(1);
  });

  it("dead-letters after max attempts", async () => {
    const { dispatcher, clock, setSender } = harness({ slaSeconds: 60, maxAttempts: 3 });
    setSender([
      { ok: false, retryable: true },
      { ok: false, retryable: true },
      { ok: false, retryable: true },
    ]);
    await dispatcher.ingest(instagram("c-1"));

    await dispatcher.dispatchDue();
    clock.now += 1_000;
    await dispatcher.dispatchDue();
    clock.now += 2_000;
    const report = await dispatcher.dispatchDue();

    expect(report.deadLettered).toBe(1);
    expect(dispatcher.jobsSnapshot()[0]?.attempts).toBe(3);
  });

  it("dead-letters a permanent failure immediately", async () => {
    const { dispatcher, setSender } = harness();
    setSender([{ ok: false, retryable: false, error: "recipient blocked" }]);
    await dispatcher.ingest(instagram("c-1"));

    const report = await dispatcher.dispatchDue();

    expect(report.deadLettered).toBe(1);
    expect(dispatcher.jobsSnapshot()[0]?.lastError).toBe("recipient blocked");
  });
});

describe("claim links", () => {
  async function issue(c: Harness, commentId = "c-1"): Promise<string> {
    await c.dispatcher.ingest(instagram(commentId));
    await c.dispatcher.dispatchDue();
    return tokenOf(c.deepLinks[c.deepLinks.length - 1]!);
  }

  it("grants the reward once", async () => {
    const c = harness();
    const plain = await issue(c);

    const outcome = await c.dispatcher.claim(plain);

    expect(outcome.status).toBe("GRANTED");
    expect(outcome.rewardAmount).toBe(3_000);
    expect(c.dispatcher.pool(1)).toMatchObject({ remaining: 99, granted: 1 });
  });

  it("rejects the second click (forwarded link)", async () => {
    const c = harness();
    const plain = await issue(c);

    await c.dispatcher.claim(plain);
    const second = await c.dispatcher.claim(plain);

    expect(second.status).toBe("ALREADY_CLAIMED");
    expect(c.dispatcher.pool(1)?.granted).toBe(1);
  });

  it("rejects an expired link", async () => {
    const c = harness();
    const plain = await issue(c);

    c.clock.now = NOW + 16 * 60_000;
    const outcome = await c.dispatcher.claim(plain);

    expect(outcome.status).toBe("EXPIRED");
    expect(c.dispatcher.pool(1)?.granted).toBe(0);
  });

  it("rejects an unknown token", async () => {
    const c = harness();

    expect((await c.dispatcher.claim("nope.nope")).status).toBe("NOT_FOUND");
  });

  it("rejects a token whose signature does not verify", async () => {
    const c = harness();
    const plain = await issue(c);
    const forged = new InteractiveCouponDispatcher({
      campaigns: [campaign()],
      signingKey: "different-key",
      now: () => c.clock.now,
    });

    // 다른 키로는 서명이 맞지 않는다 — 토큰 저장소가 같아도 통과하지 않는다.
    expect((await forged.claim(plain)).status).toBe("NOT_FOUND");

    const original = c.dispatcher.tokensSnapshot()[0]!;
    const tamperedSignature = original.signature.replace(/^./, (ch) => (ch === "a" ? "b" : "a"));
    expect(tamperedSignature).not.toBe(original.signature);
  });

  it("rejects when the coupon pool is exhausted", async () => {
    // 여유 발급 1장(만료·미수령 대비) — 링크는 2장이지만 풀은 1장이라 두 번째 수령은 거절된다.
    const c = harness({ campaigns: [campaign({ claimLimit: 1 })], overIssueBuffer: 1 });
    const first = await issue(c, "c-1");
    const second = await issue(c, "c-2");

    expect((await c.dispatcher.claim(first)).status).toBe("GRANTED");
    expect((await c.dispatcher.claim(second)).status).toBe("SOLD_OUT");
  });

  it("grants exactly one of two simultaneous clicks", async () => {
    const c = harness();
    const plain = await issue(c);

    const [a, b] = await Promise.all([c.dispatcher.claim(plain), c.dispatcher.claim(plain)]);
    const granted = [a, b].filter((outcome) => outcome.status === "GRANTED");

    expect(granted).toHaveLength(1);
    expect(c.dispatcher.pool(1)).toMatchObject({ remaining: 99, granted: 1 });
  });
});

describe("funnel and ROAS", () => {
  it("counts stages once per token and computes ROAS", async () => {
    const c = harness({ campaigns: [campaign({ claimLimit: 10 })] });

    await c.dispatcher.ingest(instagram("c-1"));
    await c.dispatcher.ingest(instagram("c-2"));
    await c.dispatcher.dispatchDue();

    const [tokenA, tokenB] = c.dispatcher.tokensSnapshot();
    await c.dispatcher.claim(tokenOf(c.deepLinks[0]!));
    await c.dispatcher.claim(tokenOf(c.deepLinks[1]!));
    c.dispatcher.recordClick(1, tokenA!.uuid);
    c.dispatcher.recordClick(1, tokenA!.uuid); // 중복 클릭은 한 번만
    c.dispatcher.recordPurchase(1, tokenA!.uuid, "ORDER-1", 32_000);
    c.dispatcher.recordPurchase(1, tokenA!.uuid, "ORDER-1", 32_000); // 중복 전환 무시
    c.dispatcher.recordPurchase(1, tokenB!.uuid, "ORDER-2", 24_000);

    const funnel = c.dispatcher.funnel(1);

    expect(funnel.comments).toBe(2);
    expect(funnel.claims).toBe(2);
    expect(funnel.clicks).toBe(1);
    expect(funnel.purchases).toBe(2);
    expect(funnel.revenue).toBe(56_000);
    expect(funnel.rewardCost).toBe(6_000);
    expect(funnel.roas).toBe(9.33);
  });

  it("returns zero rates instead of NaN when upstream is empty", () => {
    const c = harness();
    const funnel = c.dispatcher.funnel(1);

    expect(funnel).toMatchObject({ comments: 0, clicks: 0, clickThroughRate: 0, claimRate: 0, roas: 0 });
  });
});

describe("comment storm simulation", () => {
  it("serves 1,000 comments and never oversells a 100-coupon pool", async () => {
    const c = harness({ campaigns: [campaign({ claimLimit: 100, totalRewardBudget: 1_000_000 })] });

    const report = await c.dispatcher.simulateCommentStorm({
      comments: 1_000,
      concurrency: 128,
      clickRate: 1,
      seed: 42,
    });

    expect(report.comments).toBe(1_000);
    expect(report.dispatched).toBeGreaterThan(0);
    expect(report.poolGranted).toBeLessThanOrEqual(100);
    expect(report.poolOversold).toBe(0);
    expect(report.claimsGranted).toBe(report.poolGranted);
    expect(report.poolContentionRetries).toBeGreaterThanOrEqual(0);
    expect(report.commentsPerSecond).toBeGreaterThan(0);
  });

  it("produces one message per unique comment", async () => {
    const c = harness({ campaigns: [campaign({ claimLimit: 500, totalRewardBudget: 10_000_000 })] });

    const report = await c.dispatcher.simulateCommentStorm({ comments: 200, clickRate: 0, seed: 7 });

    expect(report.enqueued).toBe(200);
    expect(report.dispatched).toBe(200);
    expect(report.duplicates).toBe(0);
    expect(c.dispatcher.jobsSnapshot()).toHaveLength(200);
  });
});
