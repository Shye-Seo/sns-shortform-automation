<?php

declare(strict_types=1);

namespace Shortform\Tests\Services;

use PHPUnit\Framework\TestCase;
use Shortform\Services\InstagramConfig;
use Shortform\Services\Messaging\InstagramMessagingSender;
use Shortform\Tests\Support\StubHttpClient;

/**
 * Instagram DM adapter.
 *
 * The request shape is the integration: a private reply must address `recipient.comment_id`
 * (not the user id), the token goes in the Authorization header, and the text carries the
 * deep link. The failure classification decides whether the 5 second SLA retries or gives
 * up, so both a rate limit and an expired token are pinned.
 */
final class InstagramMessagingSenderTest extends TestCase
{
    private StubHttpClient $http;

    protected function setUp(): void
    {
        $this->http = new StubHttpClient();
    }

    private function sender(): InstagramMessagingSender
    {
        return new InstagramMessagingSender($this->http, new InstagramConfig(
            igUserId: '17841400000000000',
            accessToken: 'ig-token-abc',
            apiVersion: 'v21.0',
            baseUrl: 'https://graph.example.test',
        ));
    }

    /** @return array<string,mixed> */
    private function payload(string $commentId = 'comment-1'): array
    {
        return [
            'templateCode' => 'shortform_claim_v1',
            'deepLink' => 'https://coupon.shye.kr/c/abc.def',
            'rewardLabel' => '3,000원 즉시 할인',
            'commentId' => $commentId,
        ];
    }

    public function testPrivateReplyUsesCommentIdAndReportsMessageId(): void
    {
        $this->http->queueJson(200, ['recipient_id' => 'igsid-1', 'message_id' => 'mid.123']);

        $result = $this->sender()->send('INSTAGRAM_DM', 'author-1', $this->payload());

        self::assertTrue($result->ok);
        self::assertSame('mid.123', $result->messageId);
        self::assertSame('instagram', $result->provider);

        $request = $this->http->lastRequest();
        self::assertNotNull($request);
        self::assertSame('POST', $request->method);
        self::assertSame('https://graph.example.test/v21.0/17841400000000000/messages', $request->url);
        self::assertSame('Bearer ig-token-abc', $request->headers['Authorization'] ?? null);

        $body = json_decode((string) $request->body, true);
        self::assertSame(['comment_id' => 'comment-1'], $body['recipient'], '댓글에는 사용자 id가 아니라 comment_id로 답신해야 한다.');
        self::assertStringContainsString('https://coupon.shye.kr/c/abc.def', $body['message']['text']);
        self::assertStringContainsString('3,000원 즉시 할인', $body['message']['text']);
    }

    public function testKnownUserFallsBackToRecipientIdWhenNoCommentIdIsPresent(): void
    {
        $this->http->queueJson(200, ['message_id' => 'mid.2']);

        $this->sender()->send('INSTAGRAM_DM', 'igsid-9', ['deepLink' => 'https://coupon.shye.kr/c/x']);

        $body = json_decode((string) $this->http->lastRequest()?->body, true);
        self::assertSame(['id' => 'igsid-9'], $body['recipient']);
    }

    public function testRateLimitIsRetryable(): void
    {
        $this->http->queueJson(429, ['error' => ['message' => 'Application request limit reached', 'code' => 4]]);

        $result = $this->sender()->send('INSTAGRAM_DM', 'author-1', $this->payload());

        self::assertFalse($result->ok);
        self::assertTrue($result->retryable, '429/코드 4는 재시도해야 한다.');
        self::assertStringContainsString('code 4', $result->error);
        self::assertSame('RETRYABLE_FAILURE', $result->outcome());
    }

    public function testServerErrorIsRetryable(): void
    {
        $this->http->queueResponse(503, 'upstream unavailable');

        $result = $this->sender()->send('INSTAGRAM_DM', 'author-1', $this->payload());

        self::assertTrue($result->retryable);
        self::assertSame('instagram', $result->provider);
    }

    public function testExpiredTokenIsPermanent(): void
    {
        $this->http->queueJson(400, ['error' => ['message' => 'Error validating access token', 'code' => 190]]);

        $result = $this->sender()->send('INSTAGRAM_DM', 'author-1', $this->payload());

        self::assertFalse($result->ok);
        self::assertFalse($result->retryable, '만료 토큰은 재시도해도 같다.');
        self::assertSame('PERMANENT_FAILURE', $result->outcome());
    }

    public function testUnknownRecipientIsPermanent(): void
    {
        $this->http->queueJson(400, ['error' => ['message' => 'Invalid recipient', 'code' => 100]]);

        $result = $this->sender()->send('INSTAGRAM_DM', 'author-1', $this->payload());

        self::assertFalse($result->retryable);
    }

    public function testTransportErrorIsRetryable(): void
    {
        $this->http->queueThrowable(new \RuntimeException('Operation timed out'));

        $result = $this->sender()->send('INSTAGRAM_DM', 'author-1', $this->payload());

        self::assertFalse($result->ok);
        self::assertTrue($result->retryable);
        self::assertStringContainsString('timed out', $result->error);
    }

    public function testMissingDeepLinkIsPermanentWithoutCallingTheApi(): void
    {
        $result = $this->sender()->send('INSTAGRAM_DM', 'author-1', ['rewardLabel' => '3,000원']);

        self::assertFalse($result->ok);
        self::assertFalse($result->retryable);
        self::assertSame([], $this->http->requests, '본문이 잘못된 요청은 API로 보내지 않는다.');
    }

    public function testLongMessageIsTruncatedToTheApiLimit(): void
    {
        $this->http->queueJson(200, ['message_id' => 'mid.3']);

        $this->sender()->send('INSTAGRAM_DM', 'author-1', [
            'deepLink' => 'https://coupon.shye.kr/c/' . str_repeat('a', 4000),
            'rewardLabel' => '3,000원 즉시 할인',
        ]);

        $body = json_decode((string) $this->http->lastRequest()?->body, true);
        self::assertLessThanOrEqual(1000, mb_strlen($body['message']['text']));
    }

    public function testWrongChannelIsPermanent(): void
    {
        $result = $this->sender()->send('ALIMTALK', '01012345678', $this->payload());

        self::assertFalse($result->ok);
        self::assertFalse($result->retryable);
        self::assertSame([], $this->http->requests);
    }
}
