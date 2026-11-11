<?php

declare(strict_types=1);

namespace Shortform\Tests\Services;

use PHPUnit\Framework\TestCase;
use Shortform\Domain\Platform;
use Shortform\Services\DisabledAlertNotifier;
use Shortform\Services\InstagramConfig;
use Shortform\Services\InstagramGraphApiService;
use Shortform\Services\PublishJob;
use Shortform\Services\PublishOrchestrator;
use Shortform\Tests\Support\FakePublishStore;
use Shortform\Tests\Support\FixedClock;
use Shortform\Tests\Support\RecordingSleeper;
use Shortform\Tests\Support\StubHttpClient;

/**
 * Publish orchestration: quota gate → container → poll → publish → record → notify.
 * The interesting cases are the ones where money/quota is at stake: quota exhaustion and
 * a container that never finishes.
 */
final class PublishOrchestratorTest extends TestCase
{
    private StubHttpClient $http;
    private FakePublishStore $store;

    protected function setUp(): void
    {
        $this->http = new StubHttpClient();
        $this->store = new FakePublishStore();
    }

    private function orchestrator(): PublishOrchestrator
    {
        return new PublishOrchestrator(
            new InstagramGraphApiService(
                $this->http,
                new InstagramConfig('17841400000000000', 'IGAA-token', pollIntervalMs: 10, pollTimeoutMs: 1_000),
                FixedClock::at(),
                new RecordingSleeper(),
            ),
            $this->store,
            new DisabledAlertNotifier(),
            FixedClock::at(),
        );
    }

    private function job(?string $approved = null, ?string $current = null): PublishJob
    {
        return new PublishJob(
            tenantId: 1,
            projectId: 7,
            creatorAccountId: 3,
            platform: Platform::InstagramReels,
            videoUrl: 'https://cdn.example.com/render.mp4',
            caption: '3평 주방 수납 팁',
            hashtags: ['#주방수납'],
            projectTitle: '부산 신혼집 3평 주방 수납 정리법',
            recipientPhone: '01012345678',
            approvedContentHash: $approved,
            currentContentHash: $current,
        );
    }

    private function queueHappyPath(): void
    {
        $this->http->queueJson(200, ['data' => [['quota_usage' => 3, 'config' => ['quota_total' => 25]]]]);
        $this->http->queueJson(200, ['id' => 'container-9']);
        $this->http->queueJson(200, ['status_code' => 'FINISHED', 'status' => 'ready']);
        $this->http->queueJson(200, ['id' => 'media-9']);
        $this->http->queueJson(200, ['permalink' => 'https://www.instagram.com/reel/xyz/']);
    }

    public function testHappyPathPublishesAndRecordsEachStage(): void
    {
        $this->queueHappyPath();

        $outcome = $this->orchestrator()->publish($this->job());

        self::assertTrue($outcome->succeeded());
        self::assertSame('media-9', $outcome->mediaId);
        self::assertSame('https://www.instagram.com/reel/xyz/', $outcome->permalink);
        self::assertSame(['startPublish', 'markContainer', 'markPublished'], $this->store->callNames());

        // Quota was 3 used; after a successful publish the row records 4.
        $publishedCall = $this->store->calls[2];
        self::assertSame(4, $publishedCall[5]);
        self::assertSame(25, $publishedCall[6]);
    }

    public function testCaptionHashIsRecordedForApprovalAudit(): void
    {
        $this->queueHappyPath();

        $this->orchestrator()->publish($this->job());

        self::assertSame(64, strlen((string) $this->store->calls[0]['captionHash']));
        self::assertSame(5, count($this->http->requests), 'quota, container, status, publish, permalink');
    }

    public function testQuotaExhaustionFailsFastWithoutCreatingAContainer(): void
    {
        $this->http->queueJson(200, ['data' => [['quota_usage' => 25, 'config' => ['quota_total' => 25]]]]);

        $outcome = $this->orchestrator()->publish($this->job());

        self::assertFalse($outcome->succeeded());
        self::assertSame(PublishOrchestrator::ERROR_QUOTA_EXHAUSTED, $outcome->errorCode);
        self::assertFalse($outcome->retryable, '쿼터 소진은 재시도로 풀리지 않는다.');
        self::assertCount(1, $this->http->requests, '컨테이너를 만들지 않는다.');
        self::assertSame(['startPublish', 'markFailed'], $this->store->callNames());
    }

    public function testStaleApprovalIsRejectedBeforeTouchingTheApi(): void
    {
        $this->expectException(\DomainException::class);
        $this->expectExceptionMessage('Approval is stale');

        $this->orchestrator()->publish($this->job(approved: str_repeat('a', 64), current: str_repeat('b', 64)));
    }

    public function testContainerErrorMarksThePublishFailedWithHint(): void
    {
        $this->http->queueJson(200, ['data' => [['quota_usage' => 1, 'config' => ['quota_total' => 25]]]]);
        $this->http->queueJson(200, ['id' => 'container-bad']);
        $this->http->queueJson(200, ['status_code' => 'ERROR', 'status' => 'video_too_short']);

        $outcome = $this->orchestrator()->publish($this->job());

        self::assertFalse($outcome->succeeded());
        self::assertFalse($outcome->retryable);
        self::assertSame(['startPublish', 'markContainer', 'markFailed'], $this->store->callNames());
        self::assertStringContainsString('codec/aspect', (string) $outcome->detail['hint']);
    }

    public function testTransientPlatformErrorIsReportedAsRetryable(): void
    {
        $this->http->queueJson(200, ['data' => [['quota_usage' => 1, 'config' => ['quota_total' => 25]]]]);
        // 9007 twice: retried inside the call layer, then finally surfaced as retryable.
        $this->http->queueJson(400, ['error' => ['code' => 9007, 'message' => 'Media not ready']]);
        $this->http->queueJson(400, ['error' => ['code' => 9007, 'message' => 'Media not ready']]);
        $this->http->queueJson(400, ['error' => ['code' => 9007, 'message' => 'Media not ready']]);

        $outcome = $this->orchestrator()->publish($this->job());

        self::assertFalse($outcome->succeeded());
        self::assertTrue($outcome->retryable);
        self::assertSame(9007, $outcome->errorCode);
    }

    public function testInvalidCaptionFailsBeforeCreatingPublishRow(): void
    {
        $job = new PublishJob(
            tenantId: 1,
            projectId: 7,
            creatorAccountId: 3,
            platform: Platform::InstagramReels,
            videoUrl: 'https://cdn.example.com/render.mp4',
            caption: str_repeat('가', 2300),
            hashtags: [],
            projectTitle: '긴 캡션',
            recipientPhone: '01012345678',
        );

        $this->expectException(\InvalidArgumentException::class);
        $this->orchestrator()->publish($job);
    }
}
