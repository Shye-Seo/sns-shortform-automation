import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  InteractiveCouponDispatcher,
  type InteractiveCampaign,
} from "../src/core/interactiveCouponDispatcher";
import { InteractivePromotionConsole } from "../src/ui/InteractivePromotionConsole";

/**
 * 콘솔이 **엔진이 계산한 숫자**를 그대로 그리는지 확인한다.
 *
 * 컴포넌트가 숫자를 스스로 만들기 시작하면 데모 화면과 테스트가 검증하는 값이 갈라진다.
 * 그래서 여기서는 엔진을 실제로 돌려 리포트를 만들고, 그 값이 마크업에 있는지만 본다.
 */

const NOW = Date.parse("2026-11-10T10:00:00+09:00");

function campaign(overrides: Partial<InteractiveCampaign> = {}): InteractiveCampaign {
  return {
    id: 1,
    tenantId: 1,
    code: "reels-drop-2026-11",
    platform: "instagram",
    contentRef: "reels_1789",
    triggerKeywords: ["할인", "쿠폰"],
    rewardLabel: "3,000원 즉시 할인",
    rewardAmount: 3_000,
    claimLimit: 50,
    totalRewardBudget: 150_000,
    tokenTtlMinutes: 15,
    startsAt: NOW - 3_600_000,
    endsAt: NOW + 86_400_000,
    status: "live",
    ...overrides,
  };
}

describe("InteractivePromotionConsole", () => {
  it("renders KPIs from an actual engine run", async () => {
    const dispatcher = new InteractiveCouponDispatcher({
      campaigns: [campaign()],
      signingKey: "test-key",
      now: () => NOW,
    });

    const payload = {
      object: "instagram",
      entry: [
        {
          changes: [
            {
              value: {
                id: "c-1",
                text: "할인 주세요",
                from: { id: "author-1", username: "shye" },
                media: { id: "reels_1789" },
              },
            },
          ],
        },
      ],
    };

    const ingest = await dispatcher.ingest(payload);
    const dispatch = await dispatcher.dispatchDue();
    const storm = await dispatcher.simulateCommentStorm({ comments: 40, clickRate: 1, seed: 3 });

    const markup = renderToStaticMarkup(
      <InteractivePromotionConsole
        campaign={campaign()}
        ingest={ingest}
        dispatch={dispatch}
        funnel={dispatcher.funnel(1)}
        storm={storm}
        deadLetters={[{ id: 1, recipient: "author-9", error: "SLA_EXCEEDED", attempts: 1 }]}
        onRunStorm={() => {}}
      />,
    );

    expect(markup).toContain("댓글 → 5초 쿠폰");
    expect(markup).toContain("웹훅 접수");
    expect(markup).toContain("5초 SLA");
    expect(markup).toContain("ROAS");
    expect(markup).toContain("오버이슈");
    expect(markup).toContain("0건");
    expect(markup).toContain("SLA_EXCEEDED");
    expect(markup).toContain("댓글 1,000건 폭주 시뮬레이션");
  });

  it("shows 100% SLA when nothing has been dispatched yet", () => {
    const dispatcher = new InteractiveCouponDispatcher({
      campaigns: [campaign()],
      signingKey: "test-key",
      now: () => NOW,
    });

    const markup = renderToStaticMarkup(
      <InteractivePromotionConsole campaign={campaign()} funnel={dispatcher.funnel(1)} />,
    );

    expect(markup).toContain("100.0%");
    expect(markup).toContain("0.00x");
  });
});
