<?php

declare(strict_types=1);

namespace Shortform\Tests\Controllers;

use PHPUnit\Framework\TestCase;
use Shortform\Controllers\PublishWebhookController;
use Shortform\Http\BadRequestException;
use Shortform\Http\Request;
use Shortform\Http\WebhookRejected;
use Shortform\Repositories\WebhookApplyResult;
use Shortform\Tests\Support\FakePublishStore;
use Shortform\Tests\Support\FixedClock;

/**
 * Meta webhook contract.
 *
 * The verification handshake returns a raw string (not JSON), and the POST signature must
 * be computed over the *raw* body with the app secret. Both are one-line rules that fail in
 * a confusing way when violated, so they are pinned here.
 */
final class PublishWebhookControllerTest extends TestCase
{
    private const APP_SECRET = 'app-secret-123';
    private const VERIFY_TOKEN = 'verify-token-abc';

    private FakePublishStore $store;

    protected function setUp(): void
    {
        $this->store = new FakePublishStore();
    }

    private function controller(): PublishWebhookController
    {
        return new PublishWebhookController($this->store, self::VERIFY_TOKEN, self::APP_SECRET, FixedClock::at());
    }

    /** @param array<string,string> $query */
    private function request(string $method, array $query = [], string $body = '', array $headers = []): Request
    {
        return new Request($method, '/webhooks/instagram', $headers, $query, [], $body);
    }

    private function sign(string $body): string
    {
        return 'sha256=' . hash_hmac('sha256', $body, self::APP_SECRET);
    }

    public function testVerificationEchoesChallenge(): void
    {
        $challenge = $this->controller()->verify($this->request('GET', [
            'hub_mode' => 'subscribe',
            'hub_verify_token' => self::VERIFY_TOKEN,
            'hub_challenge' => '1158201444',
        ]));

        self::assertSame('1158201444', $challenge);
    }

    public function testVerificationAcceptsDottedParameterNames(): void
    {
        // Some proxies do not convert dots to underscores; both spellings must work.
        $challenge = $this->controller()->verify($this->request('GET', [
            'hub.mode' => 'subscribe',
            'hub.verify_token' => self::VERIFY_TOKEN,
            'hub.challenge' => '98765',
        ]));

        self::assertSame('98765', $challenge);
    }

    public function testVerificationRejectsWrongToken(): void
    {
        $this->expectException(WebhookRejected::class);

        $this->controller()->verify($this->request('GET', [
            'hub_mode' => 'subscribe',
            'hub_verify_token' => 'wrong',
            'hub_challenge' => '1',
        ]));
    }

    public function testVerificationRequiresSubscribeMode(): void
    {
        $this->expectException(BadRequestException::class);

        $this->controller()->verify($this->request('GET', [
            'hub_mode' => 'unsubscribe',
            'hub_verify_token' => self::VERIFY_TOKEN,
            'hub_challenge' => '1',
        ]));
    }

    public function testSignatureIsComputedOverRawBody(): void
    {
        $body = '{"object":"instagram","entry":[]}';

        self::assertTrue($this->controller()->isSignatureValid($body, $this->sign($body)));
        // Re-encoding the JSON changes the bytes and must invalidate the signature.
        self::assertFalse($this->controller()->isSignatureValid('{"object": "instagram", "entry": []}', $this->sign($body)));
        self::assertFalse($this->controller()->isSignatureValid($body, null));
    }

    public function testReceiveRejectsUnsignedRequest(): void
    {
        $body = json_encode(['object' => 'instagram']) ?: '{}';

        $this->expectException(WebhookRejected::class);
        $this->controller()->receive($this->request('POST', [], $body, ['x-hub-signature-256' => 'sha256=bad']));
    }

    public function testReceiveAppliesMediaEvents(): void
    {
        $body = json_encode([
            'object' => 'instagram',
            'entry' => [[
                'id' => '17841400000000000',
                'time' => 1762819200,
                'changes' => [[
                    'field' => 'media',
                    'value' => ['media_id' => 'media-42', 'permalink' => 'https://www.instagram.com/reel/xyz/'],
                ]],
            ]],
        ], JSON_UNESCAPED_UNICODE) ?: '{}';

        $result = $this->controller()->receive($this->request('POST', [], $body, ['x-hub-signature-256' => $this->sign($body)]));

        self::assertSame(1, $result['received']);
        self::assertSame(1, $result['applied']);
        self::assertSame(0, $result['duplicates']);
        self::assertSame(0, $result['unknown_media']);
        self::assertSame('media-42', $this->store->webhooks[0]['mediaId']);
        self::assertSame('published', $this->store->webhooks[0]['status']);
        self::assertStringContainsString('media-42', $this->store->webhooks[0]['eventId']);
    }

    public function testRedeliveredEventIsCountedAsDuplicate(): void
    {
        // Meta retries the same event for up to 24h; the store rejects it by last_event_id.
        $this->store->webhookResult = WebhookApplyResult::Duplicate;
        $body = json_encode([
            'object' => 'instagram',
            'entry' => [[
                'id' => '17841400000000000',
                'time' => 1762819200,
                'changes' => [['field' => 'media', 'value' => ['media_id' => 'media-42']]],
            ]],
        ]) ?: '{}';

        $result = $this->controller()->receive($this->request('POST', [], $body, ['x-hub-signature-256' => $this->sign($body)]));

        self::assertSame(1, $result['received']);
        self::assertSame(0, $result['applied']);
        self::assertSame(1, $result['duplicates']);
        self::assertSame(0, $result['unknown_media']);
    }

    public function testUnknownMediaIsReportedSeparately(): void
    {
        // A webhook for a media id we never published (post made in the app) is not a
        // duplicate; it needs a different operator response.
        $this->store->webhookResult = WebhookApplyResult::Unknown;
        $body = json_encode([
            'object' => 'instagram',
            'entry' => [['id' => '1', 'time' => 1, 'changes' => [['field' => 'media', 'value' => ['media_id' => 'media-unknown']]]]],
        ]) ?: '{}';

        $result = $this->controller()->receive($this->request('POST', [], $body, ['x-hub-signature-256' => $this->sign($body)]));

        self::assertSame(1, $result['unknown_media']);
        self::assertSame(0, $result['applied']);
        self::assertSame(0, $result['duplicates']);
    }

    public function testOtherObjectTypesAreIgnoredNotFailed(): void
    {
        $body = json_encode(['object' => 'page', 'entry' => []]) ?: '{}';

        $result = $this->controller()->receive($this->request('POST', [], $body, ['x-hub-signature-256' => $this->sign($body)]));

        self::assertSame(0, $result['received']);
        self::assertSame(1, $result['ignored']);
    }

    public function testChangeWithoutMediaIdIsIgnored(): void
    {
        $body = json_encode([
            'object' => 'instagram',
            'entry' => [['id' => '1', 'time' => 1, 'changes' => [['field' => 'media', 'value' => ['status' => 'published']]]]],
        ]) ?: '{}';

        $result = $this->controller()->receive($this->request('POST', [], $body, ['x-hub-signature-256' => $this->sign($body)]));

        self::assertSame(0, $result['received']);
        self::assertSame(1, $result['ignored']);
        self::assertSame([], $this->store->webhooks);
    }
}
