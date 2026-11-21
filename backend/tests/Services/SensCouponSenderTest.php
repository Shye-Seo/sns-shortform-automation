<?php

declare(strict_types=1);

namespace Shortform\Tests\Services;

use PHPUnit\Framework\TestCase;
use Shortform\Sens\SensConfig;
use Shortform\Services\Messaging\SensCouponSender;
use Shortform\Services\NaverCloudSensService;
use Shortform\Tests\Support\FixedClock;
use Shortform\Tests\Support\StubHttpClient;

/**
 * SENS alimtalk adapter for coupon drops.
 *
 * What is pinned: the reviewed template code is sent as configuration (not invented), the
 * recipient is normalised to digits, a 202 is a success (queued, not delivered), and a 429/5xx
 * is retryable while a 4xx template/recipient error is not.
 */
final class SensCouponSenderTest extends TestCase
{
    private StubHttpClient $http;

    private SensConfig $config;

    protected function setUp(): void
    {
        $this->http = new StubHttpClient();
        $this->config = new SensConfig(
            accessKey: 'access-key',
            secretKey: 'secret-key',
            serviceId: 'ncp:kkobizmsg:kr:1234567:shortform',
            plusFriendId: '@shortform',
            templateCodes: SensConfig::defaultTemplateCodes(),
            baseUrl: 'https://sens.example.test',
        );
    }

    private function sender(string $templateCode = 'COUPON_CLAIM_V1'): SensCouponSender
    {
        return new SensCouponSender(
            new NaverCloudSensService($this->http, $this->config, FixedClock::at('2026-11-10T10:00:00+09:00')),
            $templateCode,
            '@shortform',
        );
    }

    /** @return array<string,mixed> */
    private function payload(): array
    {
        return [
            'deepLink' => 'https://coupon.shye.kr/c/abc.def',
            'rewardLabel' => '2,000원 웰컴 쿠폰',
        ];
    }

    public function testAcceptedMessageIsReportedAsSentWithRequestId(): void
    {
        $this->http->queueJson(202, ['requestId' => 'req-1', 'statusCode' => '202', 'statusName' => 'accepted']);

        $result = $this->sender()->send('ALIMTALK', '010-1234-5678', $this->payload());

        self::assertTrue($result->ok);
        self::assertSame('req-1', $result->messageId);
        self::assertSame('sens', $result->provider);

        $request = $this->http->lastRequest();
        self::assertNotNull($request);
        self::assertStringContainsString('/alimtalk/v2/services/ncp:kkobizmsg:kr:1234567:shortform/messages', $request->url);
        self::assertArrayHasKey('x-ncp-apigw-signature-v2', $request->headers);

        $body = json_decode((string) $request->body, true);
        self::assertSame('COUPON_CLAIM_V1', $body['templateCode'], '검수된 템플릿 코드를 그대로 보낸다.');
        self::assertSame('01012345678', $body['messages'][0]['to'], '번호는 숫자만 남겨 보낸다.');
        self::assertStringContainsString('https://coupon.shye.kr/c/abc.def', $body['messages'][0]['content']);
    }

    public function testRateLimitIsRetryable(): void
    {
        $this->http->queueResponse(429, '{"status":"too many requests"}');

        $result = $this->sender()->send('ALIMTALK', '01012345678', $this->payload());

        self::assertFalse($result->ok);
        self::assertTrue($result->retryable);
    }

    public function testBadTemplateIsPermanent(): void
    {
        $this->http->queueResponse(400, '{"status":"NoMatchedTemplate"}');

        $result = $this->sender()->send('ALIMTALK', '01012345678', $this->payload());

        self::assertFalse($result->ok);
        self::assertFalse($result->retryable, '템플릿 불일치는 재시도로 풀리지 않는다.');
    }

    public function testInvalidPhoneIsPermanentAndNeverCallsSens(): void
    {
        $result = $this->sender()->send('ALIMTALK', 'not-a-phone', $this->payload());

        self::assertFalse($result->ok);
        self::assertFalse($result->retryable);
        self::assertSame([], $this->http->requests);
    }

    public function testWrongChannelIsPermanent(): void
    {
        $result = $this->sender()->send('INSTAGRAM_DM', '01012345678', $this->payload());

        self::assertFalse($result->ok);
        self::assertFalse($result->retryable);
        self::assertSame([], $this->http->requests);
    }

    public function testEmptyTemplateCodeIsRejectedAtConstruction(): void
    {
        $this->expectException(\InvalidArgumentException::class);

        $this->sender('');
    }
}
