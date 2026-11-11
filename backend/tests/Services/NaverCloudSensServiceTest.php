<?php

declare(strict_types=1);

namespace Shortform\Tests\Services;

use PHPUnit\Framework\TestCase;
use Shortform\Sens\AlimtalkEvent;
use Shortform\Sens\AlimtalkMessage;
use Shortform\Sens\RecipientPhone;
use Shortform\Sens\SensConfig;
use Shortform\Sens\SensException;
use Shortform\Services\NaverCloudSensService;
use Shortform\Tests\Support\FixedClock;
use Shortform\Tests\Support\StubHttpClient;

/**
 * SENS transport. The signature vectors were computed independently (Python hmac/base64)
 * so a regression here breaks the test instead of production.
 */
final class NaverCloudSensServiceTest extends TestCase
{
    private const SERVICE_ID = 'ncp:kkobizmsg:kr:1234567890:sens';
    private const ACCESS_KEY = 'ACCESSKEY123';
    private const SECRET_KEY = 'SECRETKEY456';

    private function config(): SensConfig
    {
        return new SensConfig(
            accessKey: self::ACCESS_KEY,
            secretKey: self::SECRET_KEY,
            serviceId: self::SERVICE_ID,
            plusFriendId: '@shortform',
            templateCodes: SensConfig::defaultTemplateCodes(),
        );
    }

    private function service(StubHttpClient $http): NaverCloudSensService
    {
        // 2026-11-11 09:00:00 +09:00 = 1794355200000 ms
        return new NaverCloudSensService($http, $this->config(), FixedClock::at('2026-11-11T09:00:00+09:00'));
    }

    public function testSignatureMatchesIndependentVector(): void
    {
        self::assertSame(
            '9qqF+lSWmkCQJ6Ud6Ksb4Yj65WgQ1q9sulIhCp5UVZA=',
            NaverCloudSensService::sign('POST', '/alimtalk/v2/services/' . self::SERVICE_ID . '/messages', '1760000000000', self::ACCESS_KEY, self::SECRET_KEY),
        );
    }

    public function testGetSignatureIncludesPathParameter(): void
    {
        self::assertSame(
            'eu8NaknI4f8AD/ZnJnZx06pSvImMHHa7mYOQ1QwIUNA=',
            NaverCloudSensService::sign('GET', '/alimtalk/v2/services/' . self::SERVICE_ID . '/messages/aa724ca6-1111-2222-3333-66dfc1a700e7', '1760000000000', self::ACCESS_KEY, self::SECRET_KEY),
        );
    }

    public function testEventSelectsTemplateCode(): void
    {
        self::assertSame('SF_RENDER_DONE', $this->config()->templateFor(AlimtalkEvent::RenderCompleted));
        self::assertSame('SF_PUBLISH_DONE', $this->config()->templateFor(AlimtalkEvent::PublishCompleted));
        self::assertSame('SF_PUBLISH_FAILED', $this->config()->templateFor(AlimtalkEvent::PublishFailed));
        self::assertSame('SF_QUOTA_EXHAUSTED', $this->config()->templateFor(AlimtalkEvent::QuotaExhausted));
    }

    public function testSendForEventBuildsSignedRequest(): void
    {
        $http = (new StubHttpClient())->queueJson(202, ['requestId' => 'R1', 'statusCode' => '202', 'statusName' => 'accepted']);

        $this->service($http)->sendForEvent(AlimtalkEvent::RenderCompleted, '010-1234-5678', '렌더 완료');

        $request = $http->lastRequest();
        self::assertNotNull($request);
        self::assertSame('1794355200000', $request->headers['x-ncp-apigw-timestamp']);
        self::assertSame(
            NaverCloudSensService::sign('POST', '/alimtalk/v2/services/' . self::SERVICE_ID . '/messages', '1794355200000', self::ACCESS_KEY, self::SECRET_KEY),
            $request->headers['x-ncp-apigw-signature-v2'],
        );

        $body = json_decode((string) $request->body, true);
        self::assertSame('SF_RENDER_DONE', $body['templateCode']);
        self::assertSame('01012345678', $body['messages'][0]['to']);
    }

    public function testBatchGroupsByTemplateAndChunksAtHundred(): void
    {
        $http = new StubHttpClient();
        $http->queueJson(202, ['requestId' => 'A1', 'statusCode' => '202', 'statusName' => 'accepted']);
        $http->queueJson(202, ['requestId' => 'A2', 'statusCode' => '202', 'statusName' => 'accepted']);
        $http->queueJson(202, ['requestId' => 'B1', 'statusCode' => '202', 'statusName' => 'accepted']);

        $messages = [];
        for ($i = 0; $i < 120; $i++) {
            $messages[] = new AlimtalkMessage('01012345678', "본문 {$i}", 'SF_RENDER_DONE', '@shortform');
        }
        $messages[] = new AlimtalkMessage('01012345678', '발행 완료', 'SF_PUBLISH_DONE', '@shortform');

        $results = $this->service($http)->sendBatch($messages);

        self::assertCount(3, $results);
        $counts = array_map(static fn ($r): int => count(json_decode((string) $r->body, true)['messages']), $http->requests);
        self::assertSame([100, 20, 1], $counts);
    }

    public function testUnauthorizedExplainsClockAndKeys(): void
    {
        $http = (new StubHttpClient())->queueJson(401, ['error' => ['message' => 'Authentication failed']]);

        try {
            $this->service($http)->sendForEvent(AlimtalkEvent::RenderCompleted, '01012345678', '본문');
            self::fail('SensException expected.');
        } catch (SensException $e) {
            self::assertFalse($e->isRetryable());
            self::assertStringContainsString('Signature rejected', $e->hint);
        }
    }

    public function testRateLimitIsRetryable(): void
    {
        $http = (new StubHttpClient())->queueResponse(429, '');

        try {
            $this->service($http)->sendForEvent(AlimtalkEvent::RenderCompleted, '01012345678', '본문');
            self::fail('SensException expected.');
        } catch (SensException $e) {
            self::assertTrue($e->isRetryable());
        }
    }

    public function testDeliveryResultDistinguishesDeliveredAndUncertain(): void
    {
        $http = new StubHttpClient();
        $http->queueJson(200, ['requestStatusCode' => 'A000', 'messageStatusCode' => '0000', 'messageId' => 'M1']);
        $http->queueJson(200, ['requestStatusCode' => 'A000', 'messageStatusCode' => '3005', 'messageId' => 'M2']);

        $service = $this->service($http);
        self::assertTrue($service->fetchDelivery('M1')->isDelivered());
        self::assertTrue($service->fetchDelivery('M2')->isUncertain());
    }

    public function testPhoneNormalisationAndMasking(): void
    {
        self::assertSame('01012345678', RecipientPhone::fromString('+82 10-1234-5678')->digits);
        self::assertSame('010-****-5678', RecipientPhone::fromString('01012345678')->masked());

        $this->expectException(\InvalidArgumentException::class);
        RecipientPhone::fromString('02-123-4567');
    }

    public function testContentLongerThanOneThousandCharsIsRejected(): void
    {
        $this->expectException(\InvalidArgumentException::class);
        new AlimtalkMessage('01012345678', str_repeat('가', 1001), 'SF_RENDER_DONE', '@shortform');
    }

    public function testChannelIdMustStartWithAt(): void
    {
        $this->expectException(\InvalidArgumentException::class);
        new SensConfig('AK', 'SK', self::SERVICE_ID, 'shortform', SensConfig::defaultTemplateCodes());
    }
}
