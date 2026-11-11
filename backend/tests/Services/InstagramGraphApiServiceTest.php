<?php

declare(strict_types=1);

namespace Shortform\Tests\Services;

use PHPUnit\Framework\TestCase;
use Shortform\Services\InstagramApiException;
use Shortform\Services\InstagramConfig;
use Shortform\Services\InstagramGraphApiService;
use Shortform\Services\ReelInput;
use Shortform\Services\TokenFlow;
use Shortform\Tests\Support\FixedClock;
use Shortform\Tests\Support\RecordingSleeper;
use Shortform\Tests\Support\StubHttpClient;

/**
 * Graph API behaviour that actually breaks in production:
 * the mandatory container poll, the daily quota, retry-vs-give-up decisions, and which
 * long-lived-token flow is being used.
 */
final class InstagramGraphApiServiceTest extends TestCase
{
    private StubHttpClient $http;
    private RecordingSleeper $sleeper;

    protected function setUp(): void
    {
        $this->http = new StubHttpClient();
        $this->sleeper = new RecordingSleeper();
    }

    private function service(int $maxRetries = 3): InstagramGraphApiService
    {
        return new InstagramGraphApiService(
            $this->http,
            new InstagramConfig(
                igUserId: '17841400000000000',
                accessToken: 'IGAA-token',
                pollIntervalMs: 2_000,
                pollTimeoutMs: 10_000,
                maxRetries: $maxRetries,
            ),
            FixedClock::at(),
            $this->sleeper,
        );
    }

    public function testBuildCaptionMergesHashtagsWithoutDuplicates(): void
    {
        $caption = "3평 주방 수납 팁 #주방수납\n두 번째 줄";

        $merged = InstagramGraphApiService::buildCaption($caption, ['#주방수납', '살림꿀팁', '부산신혼집']);

        self::assertStringContainsString('#주방수납', $merged);
        self::assertSame(1, substr_count($merged, '#주방수납'), '이미 본문에 있는 해시태그는 다시 붙이지 않는다.');
        self::assertStringContainsString('#살림꿀팁 #부산신혼집', $merged);
    }

    public function testBuildCaptionTruncatesAtPlatformLimit(): void
    {
        $merged = InstagramGraphApiService::buildCaption(str_repeat('가', 2200), ['#태그']);

        self::assertSame(2200, mb_strlen($merged));
    }

    public function testCaptionWithTooManyHashtagsIsRejectedLocally(): void
    {
        $error = InstagramGraphApiService::captionError(implode(' ', array_map(static fn (int $i): string => "#tag{$i}", range(1, 31))));

        self::assertNotNull($error);
        self::assertStringContainsString('31 hashtags', $error);
    }

    public function testCreateContainerPostsReelsFormWithToken(): void
    {
        $this->http->queueJson(200, ['id' => 'container-1']);

        $id = $this->service()->createReelContainer(new ReelInput(
            videoUrl: 'https://cdn.example.com/render.mp4',
            caption: '본문 #태그',
        ));

        self::assertSame('container-1', $id);
        $request = $this->http->lastRequest();
        self::assertNotNull($request);
        self::assertSame('POST', $request->method);
        self::assertSame('https://graph.facebook.com/v21.0/17841400000000000/media', $request->url);

        parse_str((string) $request->body, $form);
        self::assertSame('REELS', $form['media_type']);
        self::assertSame('https://cdn.example.com/render.mp4', $form['video_url']);
        self::assertSame('true', $form['share_to_feed']);
        self::assertSame('IGAA-token', $form['access_token']);
    }

    public function testScheduledContainerUsesScheduledPublishTime(): void
    {
        $this->http->queueJson(200, ['id' => 'container-2']);

        $this->service()->createReelContainer(new ReelInput(
            videoUrl: 'https://cdn.example.com/render.mp4',
            caption: '예약 발행',
            scheduleAt: new \DateTimeImmutable('2026-11-12T09:00:00+09:00'),
        ));

        parse_str((string) $this->http->lastRequest()?->body, $form);
        self::assertSame('false', $form['published']);
        self::assertSame((string) (new \DateTimeImmutable('2026-11-12T09:00:00+09:00'))->getTimestamp(), $form['scheduled_publish_time']);
    }

    public function testNonHttpsVideoUrlIsRejectedBeforeCallingMeta(): void
    {
        $this->expectException(\InvalidArgumentException::class);
        $this->expectExceptionMessage('public https video URL');

        $this->service()->createReelContainer(new ReelInput(videoUrl: 'http://cdn.example.com/render.mp4', caption: '본문'));
    }

    public function testWaitForContainerPollsWithBackoffUntilFinished(): void
    {
        $this->http->queueJson(200, ['status_code' => 'IN_PROGRESS', 'status' => 'processing']);
        $this->http->queueJson(200, ['status_code' => 'IN_PROGRESS', 'status' => 'processing']);
        $this->http->queueJson(200, ['status_code' => 'FINISHED', 'status' => 'ready']);

        $this->service()->waitForContainer('container-1');

        self::assertCount(3, $this->http->requests);
        self::assertSame([2000, 2700], $this->sleeper->delays, '2s에서 시작해 1.35배씩 늘어난다.');
    }

    public function testContainerErrorIsTerminalAndExplained(): void
    {
        $this->http->queueJson(200, ['status_code' => 'ERROR', 'status' => 'video_too_short']);

        try {
            $this->service()->waitForContainer('container-1');
            self::fail('InstagramApiException expected.');
        } catch (InstagramApiException $e) {
            self::assertFalse($e->retryable);
            self::assertStringContainsString('codec/aspect', $e->hint);
        }
        self::assertSame([], $this->sleeper->delays);
    }

    public function testPublishContainerSendsCreationId(): void
    {
        $this->http->queueJson(200, ['id' => 'media-1']);

        self::assertSame('media-1', $this->service()->publishContainer('container-1'));

        parse_str((string) $this->http->lastRequest()?->body, $form);
        self::assertSame('container-1', $form['creation_id']);
        self::assertStringContainsString('/media_publish', (string) $this->http->lastRequest()?->url);
    }

    public function testQuotaIsReadFromContentPublishingLimit(): void
    {
        $this->http->queueJson(200, ['data' => [['quota_usage' => 7, 'config' => ['quota_total' => 25]]]]);

        self::assertSame(['usage' => 7, 'total' => 25], $this->service()->getPublishingQuota());
        self::assertStringContainsString('content_publishing_limit', (string) $this->http->lastRequest()?->url);
    }

    public function testContainerNotReadyIsRetried(): void
    {
        // 9007 = container still processing. Publishing now would burn a daily slot, so the
        // call layer retries instead of surfacing it to the orchestrator.
        $this->http->queueJson(400, ['error' => ['code' => 9007, 'message' => 'Media not ready']]);
        $this->http->queueJson(200, ['id' => 'media-2']);

        self::assertSame('media-2', $this->service()->publishContainer('container-1'));
        self::assertCount(2, $this->http->requests);
        self::assertSame([700], $this->sleeper->delays);
    }

    public function testExpiredTokenIsNotRetriedAndAsksForRefresh(): void
    {
        $this->http->queueJson(400, ['error' => ['code' => 190, 'message' => 'Error validating access token']]);

        try {
            $this->service()->publishContainer('container-1');
            self::fail('InstagramApiException expected.');
        } catch (InstagramApiException $e) {
            self::assertTrue($e->needsTokenRefresh());
            self::assertFalse($e->retryable);
        }
        self::assertCount(1, $this->http->requests, '만료 토큰은 재시도해도 성공하지 않는다.');
    }

    public function testRateLimitIsRetriedUpToMaxAttempts(): void
    {
        $this->http->queueJson(429, ['error' => ['code' => 4, 'message' => 'Application request limit reached']]);
        $this->http->queueJson(429, ['error' => ['code' => 4, 'message' => 'Application request limit reached']]);

        try {
            $this->service(maxRetries: 2)->createReelContainer(new ReelInput('https://cdn.example.com/a.mp4', '본문'));
            self::fail('InstagramApiException expected.');
        } catch (InstagramApiException $e) {
            self::assertTrue($e->retryable);
        }
        self::assertCount(2, $this->http->requests);
    }

    public function testFacebookTokenFlowUsesGraphOauthEndpoint(): void
    {
        $this->http->queueJson(200, ['access_token' => 'new-token', 'expires_in' => 5184000]);

        $result = $this->service()->refreshToken('short-token', TokenFlow::FacebookExchange);

        self::assertSame('new-token', $result['accessToken']);
        self::assertSame(5184000, $result['expiresInSec']);
        self::assertStringContainsString('grant_type=fb_exchange_token', (string) $this->http->lastRequest()?->url);
    }

    public function testInstagramLoginTokenFlowUsesRefreshAccessToken(): void
    {
        $this->http->queueJson(200, ['access_token' => 'ig-token', 'expires_in' => 5184000]);

        $result = $this->service()->refreshToken('ig-token-old', TokenFlow::InstagramRefresh);

        self::assertSame('ig-token', $result['accessToken']);
        self::assertStringContainsString('https://graph.instagram.com/refresh_access_token', (string) $this->http->lastRequest()?->url);
        self::assertStringContainsString('grant_type=ig_refresh_token', (string) $this->http->lastRequest()?->url);
    }

    public function testPermalinkIsReturnedWhenPresent(): void
    {
        $this->http->queueJson(200, ['permalink' => 'https://www.instagram.com/reel/abc/']);

        self::assertSame('https://www.instagram.com/reel/abc/', $this->service()->getPermalink('media-1'));
    }
}
