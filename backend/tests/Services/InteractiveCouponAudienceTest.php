<?php

declare(strict_types=1);

namespace Shortform\Tests\Services;

use PHPUnit\Framework\TestCase;
use Shortform\Domain\Interactive\InteractiveCampaign;
use Shortform\Security\HmacTokenSigner;
use Shortform\Services\FraudDetectionService;
use Shortform\Services\InteractiveCouponDispatcher;
use Shortform\Tests\Support\FakeCampaignCatalog;
use Shortform\Tests\Support\FakeClaimTokenStore;
use Shortform\Tests\Support\FakeDispatchQueueStore;
use Shortform\Tests\Support\FakeInteractionEventStore;
use Shortform\Tests\Support\MutableClock;
use Shortform\Tests\Support\ScriptedNotificationSender;

/**
 * 팔로워 전용 필터와 슬로우 큐(발송 간격).
 *
 * 두 기능은 "쿠폰을 아껴 쓰는" 쪽이 아니라 "DM을 보내는 방식"을 바꾼다.
 *   · 팔로워 전용: 작성자가 팔로워임이 확인된 댓글에만 보낸다. 확인 안 된(null) 작성자는
 *     보내지 않는다. 모르는 사람에게 먼저 DM을 보내는 쪽이 더 큰 위험이기 때문이다.
 *   · 슬로우 큐: 같은 캠페인의 DM을 간격만큼 띄운다. 데드라인은 '보내도 되는 시각 + 5초'로
 *     함께 밀린다. 간격이 SLA를 깨는 게 아니라 대기 순서가 생기는 것이다.
 *
 * 이 파일은 두 규칙이 웹훅 경로(적재)에서 지켜지는지, 그리고 발송 시각이 실제로 벌어지는지를
 * 고정한다.
 */
final class InteractiveCouponAudienceTest extends TestCase
{
    private const NOW = '2026-11-10T10:00:00+09:00';

    private FakeCampaignCatalog $campaigns;

    private FakeInteractionEventStore $events;

    private FakeDispatchQueueStore $queue;

    private FakeClaimTokenStore $tokens;

    private ScriptedNotificationSender $sender;

    private MutableClock $clock;

    private function boot(array $overrides = []): void
    {
        $this->campaigns = new FakeCampaignCatalog();
        $this->campaigns->add($this->campaign($overrides));
        $this->events = new FakeInteractionEventStore();
        $this->queue = new FakeDispatchQueueStore();
        $this->tokens = new FakeClaimTokenStore();
        $this->sender = new ScriptedNotificationSender();
        $this->clock = MutableClock::at(self::NOW);
    }

    private function campaign(array $overrides = []): InteractiveCampaign
    {
        $now = new \DateTimeImmutable(self::NOW);

        return new InteractiveCampaign(
            id: 1,
            tenantId: 1,
            code: 'reels-drop-2026-11',
            platform: 'instagram',
            contentRef: 'reels_1789',
            triggerKeywords: ['할인', '쿠폰'],
            rewardLabel: '3,000원 즉시 할인',
            rewardAmount: 3000,
            totalRewardBudget: 300_000,
            claimLimit: 100,
            maxClaimsPerUser: 1,
            tokenTtlMinutes: 15,
            startsAt: $now->modify('-1 hour'),
            endsAt: $now->modify('+1 day'),
            status: 'live',
            followerOnly: $overrides['followerOnly'] ?? false,
            sendIntervalSeconds: $overrides['sendIntervalSeconds'] ?? 0,
        );
    }

    private function dispatcher(): InteractiveCouponDispatcher
    {
        return new InteractiveCouponDispatcher(
            $this->campaigns,
            $this->events,
            $this->queue,
            $this->tokens,
            $this->sender,
            new HmacTokenSigner('test-signing-key-32-bytes-long!!'),
            new FraudDetectionService($this->events),
            $this->clock,
        );
    }

    /**
     * @param array{is_follower?:bool|null} $from
     * @return array<string,mixed>
     */
    private function payload(string $commentId, string $author, array $from = []): array
    {
        $sender = ['id' => $author, 'username' => 'user_' . $author];
        if (array_key_exists('is_follower', $from)) {
            $sender['is_follower'] = $from['is_follower'];
        }

        return [
            'object' => 'instagram',
            'entry' => [[
                'changes' => [[
                    'field' => 'comments',
                    'value' => [
                        'id' => $commentId,
                        'text' => '쿠폰 주세요',
                        'from' => $sender,
                        'media' => ['id' => 'reels_1789'],
                    ],
                ]],
            ]],
        ];
    }

    // ── 팔로워 전용 필터 ─────────────────────────────────────────

    public function testFollowerOnlyCampaignSkipsAuthorsWhoseFollowerStatusIsUnknown(): void
    {
        $this->boot(['followerOnly' => true]);

        $result = $this->dispatcher()->handleWebhook($this->payload('c-1', 'a-1'), true);

        self::assertSame(0, $result->counts['enqueued'], '확인 안 된 작성자에게는 보내지 않는다.');
        self::assertSame(1, $result->counts['filtered']);
        self::assertSame(0, $this->queue->count());

        $event = $this->events->find('c-1');
        self::assertNotNull($event);
        self::assertSame('IGNORED', $event['status']);
        self::assertSame('FOLLOWER_ONLY', $event['rejectionReason'], '왜 보내지 않았는지 남긴다.');
    }

    public function testFollowerOnlyCampaignSkipsNonFollowers(): void
    {
        $this->boot(['followerOnly' => true]);

        $result = $this->dispatcher()->handleWebhook($this->payload('c-2', 'a-2', ['is_follower' => false]), true);

        self::assertSame(0, $result->enqueued());
        self::assertSame(1, $result->counts['filtered']);
    }

    public function testFollowerOnlyCampaignSendsToFollowers(): void
    {
        $this->boot(['followerOnly' => true]);

        $result = $this->dispatcher()->handleWebhook($this->payload('c-3', 'a-3', ['is_follower' => true]), true);

        self::assertSame(1, $result->enqueued());
        self::assertSame(0, $result->counts['filtered']);
        self::assertSame(1, $this->queue->count());
    }

    public function testOpenCampaignSendsWhenFollowerStatusIsUnknown(): void
    {
        $this->boot();

        $result = $this->dispatcher()->handleWebhook($this->payload('c-4', 'a-4'), true);

        self::assertSame(1, $result->enqueued());
        self::assertSame(0, $result->counts['filtered']);
    }

    public function testFilteredCommentDoesNotConsumeBudget(): void
    {
        $this->boot(['followerOnly' => true, 'claimLimit' => 1]);

        $this->dispatcher()->handleWebhook($this->payload('c-5', 'a-5'), true);
        $this->dispatcher()->handleWebhook($this->payload('c-6', 'a-6', ['is_follower' => true]), true);

        // 팔로워가 아닌 첫 댓글이 장수를 먹었다면 두 번째는 BUDGET_EXHAUSTED로 막혔을 것이다.
        self::assertSame(1, $this->queue->count());
        self::assertSame('QUEUED', $this->events->find('c-6')['status']);
    }

    // ── 슬로우 큐(발송 간격) ─────────────────────────────────────

    public function testSendIntervalSpacesQueuedMessagesAndMovesTheDeadline(): void
    {
        $this->boot(['sendIntervalSeconds' => 10]);

        $this->dispatcher()->handleWebhook($this->payload('c-10', 'a-10'), true);
        $this->dispatcher()->handleWebhook($this->payload('c-11', 'a-11'), true);
        $this->dispatcher()->handleWebhook($this->payload('c-12', 'a-12'), true);

        self::assertSame(3, $this->events->count());

        $first = $this->queue->row(1);
        $second = $this->queue->row(2);
        $third = $this->queue->row(3);

        $start = new \DateTimeImmutable(self::NOW);
        self::assertEquals($start, $first['availableAt'], '첫 발송은 기다리지 않는다.');
        self::assertEquals($start->modify('+10 seconds'), $second['availableAt']);
        self::assertEquals($start->modify('+20 seconds'), $third['availableAt']);

        // 데드라인은 각자의 발송 가능 시각에서 5초를 센다.
        self::assertEquals($start->modify('+5 seconds'), $first['deadline']);
        self::assertEquals($start->modify('+15 seconds'), $second['deadline']);
        self::assertEquals($start->modify('+25 seconds'), $third['deadline']);
    }

    public function testWorkerSendsOnlyTheFirstMessageUntilTheIntervalPasses(): void
    {
        $this->boot(['sendIntervalSeconds' => 10]);
        $dispatcher = $this->dispatcher();

        $dispatcher->handleWebhook($this->payload('c-20', 'a-20'), true);
        $dispatcher->handleWebhook($this->payload('c-21', 'a-21'), true);

        $first = $dispatcher->dispatchPending(10);
        self::assertSame(1, $first->counts['dispatched'], '10초 간격이면 지금은 한 건만 나간다.');
        self::assertSame(0, $first->counts['late'], '뒤에 선 건은 늦은 게 아니라 아직 차례가 아니다.');

        $this->clock->advanceSeconds(10);
        $second = $dispatcher->dispatchPending(10);
        self::assertSame(1, $second->counts['dispatched']);
        self::assertCount(2, $this->sender->sent);
    }

    public function testZeroIntervalStillEnqueuesImmediately(): void
    {
        $this->boot(['sendIntervalSeconds' => 0]);

        $this->dispatcher()->handleWebhook($this->payload('c-30', 'a-30'), true);
        $this->dispatcher()->handleWebhook($this->payload('c-31', 'a-31'), true);

        $start = new \DateTimeImmutable(self::NOW);
        self::assertEquals($start, $this->queue->row(1)['availableAt']);
        self::assertEquals($start, $this->queue->row(2)['availableAt']);
    }

    public function testIntervalIsClampedToAFullHour(): void
    {
        $campaign = $this->campaign(['sendIntervalSeconds' => 999_999]);
        self::assertSame(3600, $campaign->sendSpacingSeconds());
    }
}
