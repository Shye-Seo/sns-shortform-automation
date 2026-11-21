<?php

declare(strict_types=1);

namespace Shortform\Tests\Controllers;

use PHPUnit\Framework\TestCase;
use Shortform\Controllers\CommentsWebhookController;
use Shortform\Controllers\InstagramWebhookController;
use Shortform\Controllers\PublishWebhookController;
use Shortform\Domain\Interactive\InteractiveCampaign;
use Shortform\Http\Request;
use Shortform\Http\WebhookRejected;
use Shortform\Repositories\WebhookApplyResult;
use Shortform\Security\HmacTokenSigner;
use Shortform\Security\MetaWebhookSignatureVerifier;
use Shortform\Services\FraudDetectionService;
use Shortform\Services\InteractiveCouponDispatcher;
use Shortform\Tests\Support\FakeCampaignCatalog;
use Shortform\Tests\Support\FakeClaimTokenStore;
use Shortform\Tests\Support\FakeDispatchQueueStore;
use Shortform\Tests\Support\FakeInteractionEventStore;
use Shortform\Tests\Support\FakePublishStore;
use Shortform\Tests\Support\FixedClock;
use Shortform\Tests\Support\ScriptedNotificationSender;

/**
 * /webhooks/instagram contract for comments.
 *
 * The previous behaviour — `field: comments` counted as `ignored` — is the bug this file
 * pins shut. Each test is one production failure mode:
 *   · an unsigned comment must not create an event or a DM
 *   · a signed keyword comment must enqueue within the deadline
 *   · a redelivery must not enqueue twice
 *   · a media notification must keep working on the same URL
 *   · a body carrying both fields must do both, once
 */
final class InstagramWebhookControllerTest extends TestCase
{
    private const APP_SECRET = 'app-secret-123';
    private const VERIFY_TOKEN = 'verify-token-abc';
    private const NOW = '2026-11-10T10:00:00+09:00';
    private const MEDIA_ID = 'reels_1789';

    private FakePublishStore $publishStore;

    private FakeCampaignCatalog $campaigns;

    private FakeInteractionEventStore $events;

    private FakeDispatchQueueStore $queue;

    private FakeClaimTokenStore $tokens;

    private ScriptedNotificationSender $sender;

    protected function setUp(): void
    {
        $this->publishStore = new FakePublishStore();
        $this->campaigns = new FakeCampaignCatalog();
        $this->campaigns->add(new InteractiveCampaign(
            id: 1,
            tenantId: 1,
            code: 'reels-drop-2026-11',
            platform: 'instagram',
            contentRef: self::MEDIA_ID,
            triggerKeywords: ['할인', '선착순', '쿠폰'],
            rewardLabel: '3,000원 즉시 할인',
            rewardAmount: 3000,
            totalRewardBudget: 3_000_000,
            claimLimit: 1000,
            maxClaimsPerUser: 1,
            tokenTtlMinutes: 15,
            startsAt: (new \DateTimeImmutable(self::NOW))->modify('-1 hour'),
            endsAt: (new \DateTimeImmutable(self::NOW))->modify('+1 day'),
            status: 'live',
        ));
        $this->events = new FakeInteractionEventStore();
        $this->queue = new FakeDispatchQueueStore();
        $this->tokens = new FakeClaimTokenStore();
        $this->sender = new ScriptedNotificationSender();
    }

    private function controller(): InstagramWebhookController
    {
        $dispatcher = new InteractiveCouponDispatcher(
            $this->campaigns,
            $this->events,
            $this->queue,
            $this->tokens,
            $this->sender,
            new HmacTokenSigner('test-signing-key-32-bytes-long!!'),
            new FraudDetectionService($this->events),
            FixedClock::at(self::NOW),
        );

        return new InstagramWebhookController(
            new PublishWebhookController(
                $this->publishStore,
                self::VERIFY_TOKEN,
                new MetaWebhookSignatureVerifier(self::APP_SECRET),
                FixedClock::at(self::NOW),
            ),
            new CommentsWebhookController($dispatcher),
            new MetaWebhookSignatureVerifier(self::APP_SECRET),
        );
    }

    private function post(string $body, ?string $signature = null, string $clientIp = '203.0.113.10'): Request
    {
        return new Request(
            'POST',
            '/webhooks/instagram',
            ['x-hub-signature-256' => $signature ?? $this->sign($body)],
            [],
            [],
            $body,
            $clientIp,
        );
    }

    private function sign(string $body): string
    {
        return 'sha256=' . hash_hmac('sha256', $body, self::APP_SECRET);
    }

    /** @param array<string,mixed> $payload */
    private function body(array $payload): string
    {
        return json_encode($payload, JSON_UNESCAPED_UNICODE) ?: '{}';
    }

    /** @return array<string,mixed> */
    private function commentsPayload(string $commentId = 'c-1', string $text = '할인 받고 싶어요', string $mediaId = self::MEDIA_ID): array
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

    /** @return array<string,mixed> */
    private function mediaPayload(string $mediaId = self::MEDIA_ID): array
    {
        return [
            'object' => 'instagram',
            'entry' => [[
                'id' => 'ig-account-1',
                'time' => 1762736400,
                'changes' => [[
                    'field' => 'media',
                    'value' => ['media_id' => $mediaId, 'status' => 'published'],
                ]],
            ]],
        ];
    }

    // ── signature ────────────────────────────────────────────────

    public function testUnsignedCommentIsRejectedBeforeAnythingIsWritten(): void
    {
        $body = $this->body($this->commentsPayload());

        try {
            $this->controller()->receive($this->post($body, 'sha256=' . str_repeat('0', 64)));
            self::fail('서명이 틀린 댓글 웹훅이 통과했습니다.');
        } catch (WebhookRejected) {
            // expected
        }

        self::assertSame(0, $this->events->count());
        self::assertSame(0, $this->queue->count());
    }

    // ── comments ─────────────────────────────────────────────────

    public function testSignedKeywordCommentIsEnqueuedAndReported(): void
    {
        $response = $this->controller()->receive($this->post($this->body($this->commentsPayload('c-1'))));

        self::assertSame(1, $response['comments']['processed']);
        self::assertSame(1, $response['comments']['enqueued']);
        self::assertSame(1, $response['comments']['accepted']);
        self::assertSame('OK', $response['comments']['status']);

        self::assertSame(1, $this->queue->count(), '키워드 댓글은 발송 큐에 1건 들어가야 한다.');
        self::assertSame('INSTAGRAM_DM', $this->queue->row(1)['channel']);
        self::assertSame(
            '2026-11-10 10:00:05',
            $this->queue->row(1)['deadline']->format('Y-m-d H:i:s'),
            '5초 SLA 데드라인이 행에 박혀야 한다.',
        );

        $event = $this->events->find('c-1');
        self::assertNotNull($event);
        self::assertSame('QUEUED', $event['status']);
        self::assertTrue($event['signatureVerified']);
    }

    public function testCommentWithoutKeywordIsRecordedButNotEnqueued(): void
    {
        $response = $this->controller()->receive(
            $this->post($this->body($this->commentsPayload('c-2', '영상 잘 보고 갑니다')))
        );

        self::assertSame(1, $response['comments']['processed']);
        self::assertSame(0, $response['comments']['enqueued']);
        self::assertSame(1, $response['comments']['ignored']);
        self::assertSame('IGNORED', $this->events->find('c-2')['status']);
        self::assertSame(0, $this->queue->count());
    }

    public function testRedeliveredCommentDoesNotEnqueueTwice(): void
    {
        $body = $this->body($this->commentsPayload('c-3'));
        $controller = $this->controller();

        $first = $controller->receive($this->post($body));
        $second = $controller->receive($this->post($body));

        self::assertSame(1, $first['comments']['enqueued']);
        self::assertSame(0, $second['comments']['enqueued']);
        self::assertSame(1, $second['comments']['duplicate'], '재전송은 중복으로 집계되어야 한다.');
        self::assertSame(1, $this->queue->count());
        self::assertSame(1, $this->events->count());
    }

    public function testCommentOnAnotherPostIsIgnoredWithoutWriting(): void
    {
        $response = $this->controller()->receive(
            $this->post($this->body($this->commentsPayload('c-4', '할인', 'other_post')))
        );

        self::assertSame(0, $response['comments']['enqueued']);
        self::assertSame(0, $this->events->count(), '테넌트를 모르는 댓글은 저장하지 않는다.');
    }

    // ── media still works on the same URL ────────────────────────

    public function testMediaNotificationStillReachesThePublishingStore(): void
    {
        $this->publishStore->webhookResult = WebhookApplyResult::Applied;

        $response = $this->controller()->receive($this->post($this->body($this->mediaPayload())));

        self::assertSame(1, $response['received']);
        self::assertSame(1, $response['applied']);
        self::assertSame(0, $response['ignored']);
        self::assertSame(0, $response['comments']['processed']);
        self::assertCount(1, $this->publishStore->webhooks);
        self::assertSame('reels_1789', $this->publishStore->webhooks[0]['mediaId']);
    }

    public function testOneBodyWithMediaAndCommentsRunsBothPathsOnce(): void
    {
        $payload = [
            'object' => 'instagram',
            'entry' => [[
                'id' => 'ig-account-1',
                'time' => 1762736400,
                'changes' => [
                    ['field' => 'media', 'value' => ['media_id' => self::MEDIA_ID, 'status' => 'published']],
                    ['field' => 'comments', 'value' => [
                        'id' => 'c-5',
                        'text' => '쿠폰 주세요',
                        'from' => ['id' => 'author-c5', 'username' => 'guri'],
                        'media' => ['id' => self::MEDIA_ID],
                    ]],
                ],
            ]],
        ];

        $response = $this->controller()->receive($this->post($this->body($payload)));

        self::assertSame(1, $response['applied']);
        self::assertSame(1, $response['comments']['enqueued']);
        self::assertCount(1, $this->publishStore->webhooks);
        self::assertSame(1, $this->queue->count());
    }

    public function testUnknownObjectIsAcknowledgedWithoutProcessing(): void
    {
        $response = $this->controller()->receive($this->post($this->body(['object' => 'page', 'entry' => []])));

        self::assertSame(1, $response['ignored']);
        self::assertSame(0, $response['comments']['processed']);
        self::assertSame(0, $this->events->count());
    }
}
