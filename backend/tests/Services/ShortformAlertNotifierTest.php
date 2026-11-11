<?php

declare(strict_types=1);

namespace Shortform\Tests\Services;

use PHPUnit\Framework\TestCase;
use Shortform\Domain\Platform;
use Shortform\Sens\SensConfig;
use Shortform\Services\NaverCloudSensService;
use Shortform\Services\PublishJob;
use Shortform\Services\ShortformAlertComposer;
use Shortform\Services\ShortformAlertNotifier;
use Shortform\Tests\Support\FakeNotificationStore;
use Shortform\Tests\Support\FixedClock;
use Shortform\Tests\Support\StubHttpClient;

/** Notifications are a side effect: deduped, template-bound, and never fatal. */
final class ShortformAlertNotifierTest extends TestCase
{
    private FixedClock $clock;

    protected function setUp(): void
    {
        $this->clock = FixedClock::at('2026-11-11T09:00:00+09:00');
    }

    private function config(): SensConfig
    {
        return new SensConfig(
            accessKey: 'ACCESSKEY123',
            secretKey: 'SECRETKEY456',
            serviceId: 'ncp:kkobizmsg:kr:1234567890:sens',
            plusFriendId: '@shortform',
            templateCodes: SensConfig::defaultTemplateCodes(),
        );
    }

    private function notifier(StubHttpClient $http, FakeNotificationStore $store): ShortformAlertNotifier
    {
        return new ShortformAlertNotifier(
            new NaverCloudSensService($http, $this->config(), $this->clock),
            $store,
            new ShortformAlertComposer('https://studio.example.com'),
            $this->config(),
            $this->clock,
        );
    }

    private function job(): PublishJob
    {
        return new PublishJob(
            tenantId: 1,
            projectId: 7,
            creatorAccountId: 3,
            platform: Platform::InstagramReels,
            videoUrl: 'https://cdn.example.com/render.mp4',
            caption: '본문',
            hashtags: ['#태그'],
            projectTitle: '부산 신혼집 3평 주방 수납 정리법',
            recipientPhone: '010-1234-5678',
        );
    }

    public function testRenderCompletedUsesItsOwnTemplate(): void
    {
        $http = (new StubHttpClient())->queueJson(202, ['requestId' => 'R1', 'statusCode' => '202', 'statusName' => 'accepted']);
        $store = new FakeNotificationStore();

        self::assertTrue($this->notifier($http, $store)->notifyRenderCompleted(
            1,
            '숭구리 스튜디오',
            7,
            '부산 신혼집 3평 주방 수납 정리법',
            45.0,
            'instagram-reels',
            '01012345678',
        ));

        $body = json_decode((string) $http->lastRequest()?->body, true);
        self::assertSame('SF_RENDER_DONE', $body['templateCode']);
        self::assertSame('01012345678', $body['messages'][0]['to']);
        self::assertStringContainsString('렌더 완료', $body['messages'][0]['content']);
        self::assertCount(1, $store->accepted);
    }

    public function testSameEventIsNotSentTwice(): void
    {
        $http = new StubHttpClient();
        $store = new FakeNotificationStore([
            'notify:1:7:publish_completed',
        ]);

        self::assertFalse($this->notifier($http, $store)->notifyPublishCompleted(
            $this->job(),
            'media-1',
            'https://www.instagram.com/reel/abc/',
        ));
        self::assertSame([], $http->requests, '중복 이벤트는 SENS를 호출하지 않는다.');
    }

    public function testPublishCompletedContentCarriesPermalink(): void
    {
        $http = (new StubHttpClient())->queueJson(202, ['requestId' => 'R2', 'statusCode' => '202', 'statusName' => 'accepted']);
        $store = new FakeNotificationStore();

        self::assertTrue($this->notifier($http, $store)->notifyPublishCompleted(
            $this->job(),
            'media-2',
            'https://www.instagram.com/reel/xyz/',
        ));

        $body = json_decode((string) $http->lastRequest()?->body, true);
        self::assertSame('SF_PUBLISH_DONE', $body['templateCode']);
        self::assertStringContainsString('https://www.instagram.com/reel/xyz/', $body['messages'][0]['content']);
        self::assertStringContainsString('Instagram Reels 발행 완료', $body['messages'][0]['content']);
    }

    public function testSensFailureIsRecordedButNotThrown(): void
    {
        $http = (new StubHttpClient())->queueResponse(500, 'boom');
        $store = new FakeNotificationStore();

        self::assertFalse($this->notifier($http, $store)->notifyPublishFailed($this->job(), '쿼터 초과', '내일 재시도'));
        self::assertCount(1, $store->failures);
        self::assertStringContainsString('SENS call failed', $store->failures[0]['error']);
    }

    public function testQuotaExhaustedMessageExplainsRecovery(): void
    {
        $http = (new StubHttpClient())->queueJson(202, ['requestId' => 'R3', 'statusCode' => '202', 'statusName' => 'accepted']);
        $store = new FakeNotificationStore();

        $this->notifier($http, $store)->notifyQuotaExhausted($this->job(), ['usage' => 25, 'total' => 25]);

        $body = json_decode((string) $http->lastRequest()?->body, true);
        self::assertSame('SF_QUOTA_EXHAUSTED', $body['templateCode']);
        self::assertStringContainsString('(25/25)', $body['messages'][0]['content']);
    }

    public function testDedupeKeyIsScopedToTenantProjectAndEvent(): void
    {
        $composer = new ShortformAlertComposer();

        self::assertSame(
            'notify:1:7:render_completed',
            $composer->dedupeKey(1, 7, \Shortform\Sens\AlimtalkEvent::RenderCompleted),
        );
        self::assertNotSame(
            $composer->dedupeKey(1, 7, \Shortform\Sens\AlimtalkEvent::RenderCompleted),
            $composer->dedupeKey(2, 7, \Shortform\Sens\AlimtalkEvent::RenderCompleted),
        );
    }
}
