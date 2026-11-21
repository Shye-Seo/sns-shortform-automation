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
use Shortform\Tests\Support\FakeDispatchAttemptStore;
use Shortform\Tests\Support\FakeDispatchQueueStore;
use Shortform\Tests\Support\FakeInteractionEventStore;
use Shortform\Tests\Support\MutableClock;
use Shortform\Tests\Support\ScriptedNotificationSender;

/**
 * What the dispatch ledger adds to the pipeline.
 *
 *   · every attempt (success and failure) is recorded with the provider and message id
 *   · the minted token is attached to the queue row it was sent for
 *   · a SENT row from a previous worker means the DM already left — finish the state, do not
 *     send again (the crash window the idempotency key does not cover)
 */
final class CouponDispatchLedgerTest extends TestCase
{
    private const NOW = '2026-11-10T10:00:00+09:00';

    private FakeCampaignCatalog $campaigns;

    private FakeInteractionEventStore $events;

    private FakeDispatchQueueStore $queue;

    private FakeClaimTokenStore $tokens;

    private ScriptedNotificationSender $sender;

    private FakeDispatchAttemptStore $attempts;

    private MutableClock $clock;

    protected function setUp(): void
    {
        $now = new \DateTimeImmutable(self::NOW);
        $this->campaigns = new FakeCampaignCatalog();
        $this->campaigns->add(new InteractiveCampaign(
            id: 1,
            tenantId: 1,
            code: 'reels-drop-2026-11',
            platform: 'instagram',
            contentRef: 'reels_1789',
            triggerKeywords: ['할인', '쿠폰'],
            rewardLabel: '3,000원 즉시 할인',
            rewardAmount: 3000,
            totalRewardBudget: 3_000_000,
            claimLimit: 1000,
            maxClaimsPerUser: 1,
            tokenTtlMinutes: 15,
            startsAt: $now->modify('-1 hour'),
            endsAt: $now->modify('+1 day'),
            status: 'live',
        ));
        $this->events = new FakeInteractionEventStore();
        $this->queue = new FakeDispatchQueueStore();
        $this->tokens = new FakeClaimTokenStore();
        $this->sender = new ScriptedNotificationSender();
        $this->attempts = new FakeDispatchAttemptStore();
        $this->clock = MutableClock::at(self::NOW);
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
            attempts: $this->attempts,
        );
    }

    /** @return array<string,mixed> */
    private function payload(string $commentId = 'c-1'): array
    {
        return [
            'object' => 'instagram',
            'entry' => [[
                'changes' => [[
                    'field' => 'comments',
                    'value' => [
                        'id' => $commentId,
                        'text' => '할인 받고 싶어요',
                        'from' => ['id' => 'author-' . $commentId, 'username' => 'shye'],
                        'media' => ['id' => 'reels_1789'],
                    ],
                ]],
            ]],
        ];
    }

    public function testSuccessfulDispatchWritesLedgerAndAttachesTheToken(): void
    {
        $dispatcher = $this->dispatcher();
        $dispatcher->handleWebhook($this->payload('c-1'), true, '203.0.113.10');

        $report = $dispatcher->dispatchPending(10, 'it-worker');

        self::assertSame(1, $report->dispatched());
        self::assertSame(1, $this->attempts->count());

        $attempt = $this->attempts->rows[0];
        self::assertSame('SENT', $attempt['outcome']);
        self::assertSame(1, $attempt['attemptNo']);
        self::assertSame(1, $attempt['dispatchId']);
        self::assertSame('INSTAGRAM_DM', $attempt['channel']);
        self::assertNotNull($attempt['claimTokenId'], '발급한 토큰 id가 발송 이력에 남아야 한다.');
        self::assertStringStartsWith('https://coupon.shye.kr/c/', (string) $attempt['payload']['deepLink']);
        self::assertNotNull($attempt['messageId']);

        $token = $this->tokens->all()[0];
        self::assertSame($token->id, $this->queue->row(1)['claimTokenId'], '큐 행이 발급 토큰을 가리켜야 한다.');
        self::assertSame('DISPATCHED', $this->events->find('c-1')['status']);
    }

    public function testRetryableFailureIsRecordedAsSuch(): void
    {
        $this->sender = new ScriptedNotificationSender(['retryable']);
        $dispatcher = $this->dispatcher();
        $dispatcher->handleWebhook($this->payload('c-2'), true);
        $dispatcher->dispatchPending();

        self::assertSame('RETRYABLE_FAILURE', $this->attempts->rows[0]['outcome']);
        self::assertSame('RETRY', $this->queue->row(1)['status']);
    }

    public function testPermanentFailureIsRecorded(): void
    {
        $this->sender = new ScriptedNotificationSender(['permanent']);
        $dispatcher = $this->dispatcher();
        $dispatcher->handleWebhook($this->payload('c-3'), true);
        $dispatcher->dispatchPending();

        self::assertSame('PERMANENT_FAILURE', $this->attempts->rows[0]['outcome']);
        self::assertSame('DEAD_LETTER', $this->queue->row(1)['status']);
    }

    public function testWorkerRestartAfterSendDoesNotSendAgain(): void
    {
        $dispatcher = $this->dispatcher();
        $dispatcher->handleWebhook($this->payload('c-4'), true);
        $dispatcher->dispatchPending();
        $sentCount = count($this->sender->sent);

        // Simulate the crash window: the DM went out, but the queue row never reached
        // DISPATCHED (the SENT attempt is the only evidence).
        $this->queue->markRetry(1, $this->clock->now(), 'worker killed after send');

        $report = $dispatcher->dispatchPending();

        self::assertSame($sentCount, count($this->sender->sent), '이미 보낸 DM을 다시 보내지 않는다.');
        self::assertSame(1, $report->counts['recovered']);
        self::assertSame('DISPATCHED', $this->queue->row(1)['status']);
    }

    public function testClaimLinkFromTheLedgerGrantsExactlyOnce(): void
    {
        $dispatcher = $this->dispatcher();
        $dispatcher->handleWebhook($this->payload('c-5'), true);
        $dispatcher->dispatchPending();

        $deepLink = (string) $this->attempts->rows[0]['payload']['deepLink'];
        $token = rawurldecode(substr($deepLink, strrpos($deepLink, '/') + 1));

        $first = $dispatcher->claim($token);
        $second = $dispatcher->claim($token);

        self::assertTrue($first->isGranted());
        self::assertSame(3000, $first->rewardAmount);
        self::assertSame('ALREADY_CLAIMED', $second->outcome);
    }
}
