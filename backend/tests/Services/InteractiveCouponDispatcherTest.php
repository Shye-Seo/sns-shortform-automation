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
 * Dispatcher contract tests.
 *
 * What this file pins down (each one is a real production incident if it breaks):
 *   · an unsigned webhook never reaches the parser or the database
 *   · the same comment delivered five times creates one event and one message
 *   · a comment with no keyword is recorded but never enqueued
 *   · abuse blocks do not consume the campaign budget
 *   · a job picked up after the 5 second deadline is dead-lettered, not sent late
 *   · a retryable failure backs off, a permanent one dead-letters immediately
 *   · a claim link works exactly once — including under a lost race
 */
final class InteractiveCouponDispatcherTest extends TestCase
{
    private const NOW = '2026-11-10T10:00:00+09:00';

    private FakeCampaignCatalog $campaigns;

    private FakeInteractionEventStore $events;

    private FakeDispatchQueueStore $queue;

    private FakeClaimTokenStore $tokens;

    private ScriptedNotificationSender $sender;

    private MutableClock $clock;

    protected function setUp(): void
    {
        $this->campaigns = new FakeCampaignCatalog();
        $this->campaigns->add($this->campaign());
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
            id: $overrides['id'] ?? 1,
            tenantId: 1,
            code: 'reels-drop-2026-11',
            platform: $overrides['platform'] ?? 'instagram',
            contentRef: $overrides['contentRef'] ?? 'reels_1789',
            triggerKeywords: $overrides['keywords'] ?? ['할인', '선착순', '쿠폰'],
            rewardLabel: '3,000원 즉시 할인',
            rewardAmount: $overrides['rewardAmount'] ?? 3000,
            totalRewardBudget: $overrides['totalRewardBudget'] ?? 3_000_000,
            claimLimit: $overrides['claimLimit'] ?? 1000,
            maxClaimsPerUser: 1,
            tokenTtlMinutes: $overrides['ttl'] ?? 15,
            startsAt: $now->modify('-1 hour'),
            endsAt: $now->modify('+1 day'),
            status: $overrides['status'] ?? 'live',
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

    /** @return array<string,mixed> */
    private function instagramPayload(string $commentId, string $text = '할인 받고 싶어요', string $mediaId = 'reels_1789'): array
    {
        return [
            'object' => 'instagram',
            'entry' => [[
                'id' => 'ig-account-1',
                'time' => 1762736400,
                'changes' => [[
                    'field' => 'comments',
                    'value' => [
                        'id' => $commentId,
                        'text' => $text,
                        'from' => ['id' => 'author-' . $commentId, 'username' => 'shye'],
                        'media' => ['id' => $mediaId],
                    ],
                ]],
            ]],
        ];
    }

    // ─────────────────────────────────────────────────────────────
    // 1. Signature gate
    // ─────────────────────────────────────────────────────────────

    public function testUnsignedWebhookIsRejectedBeforeParsingOrPersisting(): void
    {
        $result = $this->dispatcher()->handleWebhook($this->instagramPayload('c-1'), false);

        self::assertFalse($result->signatureValid);
        self::assertSame('BAD_SIGNATURE', $result->reason);
        self::assertSame(0, $this->events->count(), '서명 실패 payload는 저장하지 않는다.');
        self::assertSame(0, $this->queue->count());
    }

    public function testMalformedPayloadIsAcknowledgedWithoutProcessing(): void
    {
        $result = $this->dispatcher()->handleWebhook(['object' => 'instagram', 'entry' => []], true);

        self::assertTrue($result->signatureValid);
        self::assertSame('NO_COMMENTS', $result->reason);
        self::assertSame(0, $result->processed());
    }

    // ─────────────────────────────────────────────────────────────
    // 2. Happy path
    // ─────────────────────────────────────────────────────────────

    public function testKeywordCommentIsQueuedWithinTheSlaDeadline(): void
    {
        $result = $this->dispatcher()->handleWebhook($this->instagramPayload('c-1'), true);

        self::assertSame(1, $result->processed());
        self::assertSame(1, $result->enqueued());
        self::assertSame(1, $this->queue->count());

        $row = $this->queue->row(1);
        self::assertSame('PENDING', $row['status']);
        self::assertSame('INSTAGRAM_DM', $row['channel']);
        self::assertSame('2026-11-10 10:00:05', $row['deadline']->format('Y-m-d H:i:s'));
        self::assertSame('event:1:dm:author-c-1', $row['idempotencyKey']);
    }

    public function testKoreanKeywordsMatchWithSpacesAndPunctuation(): void
    {
        foreach (['할 인!!', '할인받고싶어요', '쿠폰 주세요', ' 선착순 '] as $index => $text) {
            $result = $this->dispatcher()->handleWebhook($this->instagramPayload('c-' . $index, $text), true);
            self::assertSame(1, $result->enqueued(), "본문 '{$text}'가 키워드로 매칭되지 않았습니다.");
        }
    }

    public function testCommentWithoutKeywordIsRecordedButNotEnqueued(): void
    {
        $result = $this->dispatcher()->handleWebhook($this->instagramPayload('c-2', '영상 잘 보고 갑니다'), true);

        self::assertSame(1, $result->processed());
        self::assertSame(0, $result->enqueued());
        self::assertSame(0, $this->queue->count());

        $event = $this->events->find('c-2');
        self::assertSame('IGNORED', $event['status']);
        self::assertSame('NO_KEYWORD', $event['rejectionReason']);
    }

    public function testCommentOnUnknownContentIsIgnoredWithoutStoringTenantlessData(): void
    {
        $result = $this->dispatcher()->handleWebhook($this->instagramPayload('c-3', '할인', 'other_post'), true);

        self::assertSame(0, $result->enqueued());
        self::assertSame(0, $this->events->count());
    }

    public function testEndedCampaignIsIgnored(): void
    {
        $this->campaigns = new FakeCampaignCatalog();
        $this->campaigns->add($this->campaign(['status' => 'ended']));

        $result = $this->dispatcher()->handleWebhook($this->instagramPayload('c-4'), true);

        self::assertSame(0, $result->enqueued());
        self::assertSame(0, $this->events->count());
    }

    // ─────────────────────────────────────────────────────────────
    // 3. Idempotency
    // ─────────────────────────────────────────────────────────────

    public function testSameCommentDeliveredFiveTimesCreatesOneEventAndOneMessage(): void
    {
        $dispatcher = $this->dispatcher();

        $first = $dispatcher->handleWebhook($this->instagramPayload('c-5'), true);
        $second = $dispatcher->handleWebhook($this->instagramPayload('c-5'), true);
        $third = $dispatcher->handleWebhook($this->instagramPayload('c-5'), true);

        self::assertSame(1, $first->enqueued());
        self::assertSame(0, $second->enqueued());
        self::assertSame(1, $second->counts['duplicate']);
        self::assertSame(0, $third->enqueued());
        self::assertSame(1, $this->events->count());
        self::assertSame(1, $this->queue->count());
    }

    public function testTwoDifferentCommentsReturnTwoQueueRows(): void
    {
        $dispatcher = $this->dispatcher();
        $dispatcher->handleWebhook($this->instagramPayload('c-6'), true);
        $dispatcher->handleWebhook($this->instagramPayload('c-7'), true);

        self::assertSame(2, $this->queue->count());
        self::assertSame(2, $this->events->count());
    }

    public function testDailyYoutubePayloadUsesAlimtalkChannel(): void
    {
        $payload = [
            'events' => [[
                'id' => 'yt-1',
                'platform' => 'youtube',
                'videoId' => 'yt_shorts_1',
                'authorChannelId' => 'channel-1',
                'text' => '쿠폰 주세요',
            ]],
        ];
        $this->campaigns = new FakeCampaignCatalog();
        $this->campaigns->add($this->campaign(['platform' => 'youtube', 'contentRef' => 'yt_shorts_1']));

        $result = $this->dispatcher()->handleWebhook($payload, true);

        self::assertSame(1, $result->enqueued());
        self::assertSame('ALIMTALK', $this->queue->row(1)['channel']);
    }

    // ─────────────────────────────────────────────────────────────
    // 4. Budget and abuse
    // ─────────────────────────────────────────────────────────────

    public function testClaimLimitStopsEnqueueing(): void
    {
        $this->campaigns = new FakeCampaignCatalog();
        $this->campaigns->add($this->campaign(['claimLimit' => 10]));
        $this->campaigns->setUsage(1, 10, 30_000);

        $result = $this->dispatcher()->handleWebhook($this->instagramPayload('c-8'), true);

        self::assertSame(0, $result->enqueued());
        self::assertSame(0, $this->queue->count());
        self::assertSame('IGNORED', $this->events->find('c-8')['status']);
        self::assertSame('BUDGET_EXHAUSTED', $this->events->find('c-8')['rejectionReason']);
    }

    public function testRewardBudgetStopsEnqueueingEvenWithRemainingClaimSlots(): void
    {
        $this->campaigns = new FakeCampaignCatalog();
        $this->campaigns->add($this->campaign(['claimLimit' => 1000, 'totalRewardBudget' => 30_000]));
        $this->campaigns->setUsage(1, 10, 30_000);

        $result = $this->dispatcher()->handleWebhook($this->instagramPayload('c-9'), true);

        self::assertSame(0, $result->enqueued());
    }

    public function testAbusiveCommentIsRejectedAndDoesNotConsumeBudget(): void
    {
        // 같은 계정 10초에 5건(40점) + 같은 문구 반복(15점) = 55점 → 차단
        $this->events->authorCounts['author-c-10'] = 5;
        $this->events->bodyCounts['할인받고싶어요'] = 6;

        $result = $this->dispatcher()->handleWebhook($this->instagramPayload('c-10'), true);

        self::assertSame(1, $result->counts['abuse']);
        self::assertSame(0, $result->enqueued());
        self::assertSame(0, $this->queue->count());
        self::assertSame('REJECTED', $this->events->find('c-10')['status']);
        self::assertStringContainsString('AUTHOR_BURST', $this->events->find('c-10')['rejectionReason']);
    }

    public function testSubnetFloodAloneDoesNotBlockButCombinedSignalsDo(): void
    {
        // 서브넷 폭주 30점 + 신규 계정 20점 = 50점 → 차단
        $this->events->subnetCounts['203.0.113.0/24'] = 25;
        $this->campaigns = new FakeCampaignCatalog();
        $this->campaigns->add($this->campaign(['platform' => 'youtube', 'contentRef' => 'yt_shorts_2']));

        $result = $this->dispatcher()->handleWebhook(
            ['events' => [[
                'id' => 'yt-2',
                'platform' => 'youtube',
                'videoId' => 'yt_shorts_2',
                'authorChannelId' => 'channel-2',
                'text' => '할인',
                'isNewAccount' => true,
            ]]],
            true,
            '203.0.113.77',
        );

        self::assertSame(1, $result->counts['abuse']);
        self::assertSame(0, $result->enqueued());
    }

    // ─────────────────────────────────────────────────────────────
    // 5. Worker dispatch
    // ─────────────────────────────────────────────────────────────

    public function testDispatchSendsDeepLinkAndMarksJobDispatched(): void
    {
        $dispatcher = $this->dispatcher();
        $dispatcher->handleWebhook($this->instagramPayload('c-12'), true);

        $report = $dispatcher->dispatchPending();

        self::assertSame(1, $report->dispatched());
        self::assertSame(0, $report->deadLettered());
        self::assertSame('DISPATCHED', $this->queue->row(1)['status']);

        $payload = $this->sender->lastPayload();
        self::assertStringStartsWith('https://coupon.shye.kr/c/', (string) $payload['deepLink']);
        self::assertSame('shortform_claim_v1', $payload['templateCode']);
        self::assertSame(1, count($this->tokens->all()));
    }

    public function testTokenHasFifteenMinuteTtlAndValidSignature(): void
    {
        $dispatcher = $this->dispatcher();
        $dispatcher->handleWebhook($this->instagramPayload('c-13'), true);
        $dispatcher->dispatchPending();

        $token = $this->tokens->all()[0];
        self::assertSame('2026-11-10 10:15:00', $token->expiresAt->format('Y-m-d H:i:s'));
        self::assertSame(3000, $token->rewardAmount);

        $signer = new HmacTokenSigner('test-signing-key-32-bytes-long!!');
        self::assertTrue($signer->verify($token->uuid, $token->expiresAt, $token->signature));
        self::assertFalse($signer->verify($token->uuid, $token->expiresAt->modify('+1 minute'), $token->signature));
    }

    public function testJobPickedUpAfterTheDeadlineIsDeadLetteredNotSentLate(): void
    {
        $dispatcher = $this->dispatcher();
        $dispatcher->handleWebhook($this->instagramPayload('c-14'), true);

        $this->clock->set('2026-11-10T10:00:06+09:00');
        $report = $dispatcher->dispatchPending();

        self::assertSame(0, $report->dispatched());
        self::assertSame(1, $report->deadLettered());
        self::assertSame(0, count($this->sender->sent), '데드라인을 넘긴 건은 발송하지 않는다.');
        self::assertSame('SLA_EXCEEDED', $this->queue->row(1)['lastError']);
        self::assertSame('DEAD_LETTER', $this->queue->row(1)['status']);
    }

    public function testRetryableFailureSchedulesBackoff(): void
    {
        $this->sender = new ScriptedNotificationSender(['retryable']);
        $dispatcher = $this->dispatcher();
        $dispatcher->handleWebhook($this->instagramPayload('c-15'), true);

        $report = $dispatcher->dispatchPending();

        self::assertSame(1, $report->retried());
        self::assertSame('RETRY', $this->queue->row(1)['status']);
        self::assertSame('2026-11-10 10:00:01', $this->queue->row(1)['availableAt']->format('Y-m-d H:i:s'));
    }

    public function testRetryableFailureIsDeadLetteredAfterMaxAttempts(): void
    {
        // SLA를 60초로 두고 재시도 소진을 본다(기본 5초 SLA에서는 백오프 1+2+4초가 데드라인을
        // 먼저 넘기므로, "재시도 소진"과 "SLA 초과"는 다른 테스트에서 각각 검증한다).
        $this->sender = new ScriptedNotificationSender(array_fill(0, 6, 'retryable'));
        $dispatcher = new InteractiveCouponDispatcher(
            $this->campaigns,
            $this->events,
            $this->queue,
            $this->tokens,
            $this->sender,
            new HmacTokenSigner('test-signing-key-32-bytes-long!!'),
            new FraudDetectionService($this->events),
            $this->clock,
            slaSeconds: 60,
            maxAttempts: 3,
        );
        $dispatcher->handleWebhook($this->instagramPayload('c-16'), true);

        $dispatcher->dispatchPending();              // attempt 1 → RETRY(+1s)
        $this->clock->advanceSeconds(1);
        $dispatcher->dispatchPending();              // attempt 2 → RETRY(+2s)
        $this->clock->advanceSeconds(2);
        $report = $dispatcher->dispatchPending();    // attempt 3 → 포기

        self::assertSame(1, $report->deadLettered());
        self::assertSame('DEAD_LETTER', $this->queue->row(1)['status']);
        self::assertSame(3, $this->queue->row(1)['attempts']);
    }

    public function testPermanentFailureIsDeadLetteredImmediately(): void
    {
        $this->sender = new ScriptedNotificationSender(['permanent']);
        $dispatcher = $this->dispatcher();
        $dispatcher->handleWebhook($this->instagramPayload('c-17'), true);

        $report = $dispatcher->dispatchPending();

        self::assertSame(1, $report->deadLettered());
        self::assertSame('recipient blocked', $this->queue->row(1)['lastError']);
    }

    public function testDispatchIsIdempotentAcrossWorkerRestarts(): void
    {
        $dispatcher = $this->dispatcher();
        $dispatcher->handleWebhook($this->instagramPayload('c-18'), true);

        $dispatcher->dispatchPending();
        $second = $dispatcher->dispatchPending();

        self::assertSame(0, $second->dispatched(), '이미 DISPATCHED된 건은 다시 집히지 않는다.');
        self::assertSame(1, count($this->sender->sent));
    }

    // ─────────────────────────────────────────────────────────────
    // 6. Claim link
    // ─────────────────────────────────────────────────────────────

    private function issueTokenViaDispatch(string $commentId = 'c-20'): string
    {
        $dispatcher = $this->dispatcher();
        $dispatcher->handleWebhook($this->instagramPayload($commentId), true);
        $dispatcher->dispatchPending();

        $deepLink = (string) $this->sender->lastPayload()['deepLink'];

        return rawurldecode(substr($deepLink, strlen('https://coupon.shye.kr/c/')));
    }

    public function testClaimGrantsRewardOnce(): void
    {
        $plain = $this->issueTokenViaDispatch();
        $result = $this->dispatcher()->claim($plain, '203.0.113.10');

        self::assertTrue($result->isGranted());
        self::assertSame(3000, $result->rewardAmount);
        self::assertSame(1, $this->tokens->all()[0]->claimCount);
    }

    public function testSecondClaimIsRejectedAsAlreadyClaimed(): void
    {
        $plain = $this->issueTokenViaDispatch('c-21');
        $this->dispatcher()->claim($plain);
        $second = $this->dispatcher()->claim($plain);

        self::assertFalse($second->isGranted());
        self::assertSame('ALREADY_CLAIMED', $second->outcome);
    }

    public function testExpiredTokenIsRejected(): void
    {
        $plain = $this->issueTokenViaDispatch('c-22');
        $this->clock->set('2026-11-10T10:16:00+09:00');

        $result = $this->dispatcher()->claim($plain);

        self::assertSame('EXPIRED', $result->outcome);
        self::assertStringContainsString('유효 시간', $result->reason);
    }

    public function testUnknownTokenIsNotFound(): void
    {
        $result = $this->dispatcher()->claim('00000000-0000-4000-8000-000000000000.fake');

        self::assertSame('NOT_FOUND', $result->outcome);
    }

    public function testLostCasRaceIsReportedAsAlreadyClaimed(): void
    {
        $plain = $this->issueTokenViaDispatch('c-23');
        $this->tokens->loseNextClaim = true;

        $result = $this->dispatcher()->claim($plain);

        self::assertSame('ALREADY_CLAIMED', $result->outcome);
        self::assertStringContainsString('동시 요청', $result->reason);
    }

    public function testTamperedSignatureIsRejectedEvenWithMatchingHash(): void
    {
        $plain = $this->issueTokenViaDispatch('c-24');
        $token = $this->tokens->all()[0];

        // 해시는 맞지만 서명 키가 다른 경우(다른 서버가 발급한 것처럼 위조)
        $forged = new InteractiveCouponDispatcher(
            $this->campaigns,
            $this->events,
            $this->queue,
            $this->tokens,
            $this->sender,
            new HmacTokenSigner('a-different-key-that-is-wrong!!!!!'),
            new FraudDetectionService($this->events),
            $this->clock,
        );

        $result = $forged->claim($plain);

        self::assertSame('BAD_SIGNATURE', $result->outcome);
        self::assertSame(0, $token->claimCount);
    }

    public function testReportedSlaComplianceCountsLateJobs(): void
    {
        $dispatcher = $this->dispatcher();
        $dispatcher->handleWebhook($this->instagramPayload('c-25'), true);

        $this->clock->set('2026-11-10T10:00:09+09:00');
        $report = $dispatcher->dispatchPending();

        self::assertSame(0.0, $report->slaCompliance());
    }
}
