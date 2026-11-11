<?php

declare(strict_types=1);

namespace Shortform\Tests\Security;

use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;
use Shortform\Http\WebhookRejected;
use Shortform\Security\MetaWebhookSignatureVerifier;

/**
 * Signature verification is the only authentication on the webhook route, so every branch
 * (including the ones that only happen when something is misconfigured) is pinned here.
 */
final class MetaWebhookSignatureVerifierTest extends TestCase
{
    private const SECRET = 'app-secret-123';

    private const BODY = '{"object":"instagram","entry":[{"id":"17841400000000000","time":1762819200}]}';

    private function verifier(string $secret = self::SECRET): MetaWebhookSignatureVerifier
    {
        return new MetaWebhookSignatureVerifier($secret);
    }

    private function digest(string $body = self::BODY, string $secret = self::SECRET): string
    {
        return 'sha256=' . hash_hmac('sha256', $body, $secret);
    }

    public function testAcceptsValidSignature(): void
    {
        self::assertTrue($this->verifier()->verify(self::BODY, $this->digest()));
        self::assertNull($this->verifier()->failureReason(self::BODY, $this->digest()));
    }

    public function testSignReturnsTheHeaderMetaWouldSend(): void
    {
        self::assertSame($this->digest(), $this->verifier()->sign(self::BODY));
        self::assertTrue($this->verifier()->verify(self::BODY, $this->verifier()->sign(self::BODY)));
    }

    public function testRejectsForgedSignature(): void
    {
        // Same shape and length, one bit different — the classic tampering case.
        $forged = 'sha256=' . str_repeat('a', 64);

        self::assertFalse($this->verifier()->verify(self::BODY, $forged));
        self::assertSame(
            MetaWebhookSignatureVerifier::REASON_MISMATCH,
            $this->verifier()->failureReason(self::BODY, $forged),
        );
    }

    public function testRejectsBodyChangedAfterSigning(): void
    {
        $signed = $this->digest(self::BODY);
        $tamperedBody = str_replace('17841400000000000', '17841400000000001', self::BODY);

        self::assertFalse($this->verifier()->verify($tamperedBody, $signed));
    }

    public function testRejectsSignatureFromAnotherSecret(): void
    {
        $otherSecret = $this->digest(self::BODY, 'another-secret');

        self::assertFalse($this->verifier()->verify(self::BODY, $otherSecret));
    }

    public function testRejectsMissingHeader(): void
    {
        self::assertFalse($this->verifier()->verify(self::BODY, null));
        self::assertSame(
            MetaWebhookSignatureVerifier::REASON_MISSING_HEADER,
            $this->verifier()->failureReason(self::BODY, null),
        );
    }

    public function testRejectsBlankHeader(): void
    {
        self::assertFalse($this->verifier()->verify(self::BODY, '   '));
        self::assertSame(
            MetaWebhookSignatureVerifier::REASON_MISSING_HEADER,
            $this->verifier()->failureReason(self::BODY, '   '),
        );
    }

    public function testRejectsWhenSecretIsNotConfigured(): void
    {
        // Fail closed: an empty secret must never mean "accept everything".
        self::assertFalse($this->verifier('')->isConfigured());
        self::assertFalse($this->verifier('')->verify(self::BODY, $this->digest()));

        // Even a header computed with an empty key is rejected.
        $unsigned = 'sha256=' . hash_hmac('sha256', self::BODY, '');
        self::assertSame(
            MetaWebhookSignatureVerifier::REASON_MISSING_SECRET,
            $this->verifier('')->failureReason(self::BODY, $unsigned),
        );
    }

    public function testRejectsLegacySha1Header(): void
    {
        $sha1 = 'sha1=' . hash_hmac('sha1', self::BODY, self::SECRET);

        self::assertFalse($this->verifier()->verify(self::BODY, $sha1));
        self::assertSame(
            MetaWebhookSignatureVerifier::REASON_LEGACY_SHA1,
            $this->verifier()->failureReason(self::BODY, $sha1),
        );
    }

    /** @return array<string, array{string}> */
    public static function malformedHeaders(): array
    {
        return [
            'no prefix' => [hash_hmac('sha256', self::BODY, self::SECRET)],
            'wrong prefix' => ['md5=' . str_repeat('0', 64)],
            'too short hex' => ['sha256=abc123'],
            'too long hex' => ['sha256=' . str_repeat('0', 128)],
            'empty digest' => ['sha256='],
        ];
    }

    #[DataProvider('malformedHeaders')]
    public function testRejectsMalformedHeaders(string $header): void
    {
        self::assertFalse($this->verifier()->verify(self::BODY, $header));
        self::assertNotNull($this->verifier()->failureReason(self::BODY, $header));
    }

    public function testAcceptsUppercaseHexAndSurroundingWhitespace(): void
    {
        // Proxies and HTTP clients have been known to upper-case hex or add whitespace; a valid
        // signature must not be rejected because of formatting.
        $header = '  ' . strtoupper($this->digest()) . "\n";

        self::assertTrue($this->verifier()->verify(self::BODY, $header));
    }

    public function testAcceptsSignatureOverUtf8Body(): void
    {
        // Meta payloads carry Korean captions and emoji; the HMAC is over bytes, not characters.
        $body = '{"object":"instagram","caption":"부산 신혼집 3평 주방 정리 🍳"}';

        self::assertTrue($this->verifier()->verify($body, $this->digest($body)));
    }

    public function testEmptyBodyIsVerifiableButStillSigned(): void
    {
        // An empty body has a valid signature; rejecting it is a separate (JSON) concern.
        self::assertTrue($this->verifier()->verify('', $this->digest('')));
        self::assertFalse($this->verifier()->verify('', $this->digest(self::BODY)));
    }

    public function testAssertValidThrowsWithActionableMessage(): void
    {
        $this->expectException(WebhookRejected::class);
        $this->expectExceptionMessage('X-Hub-Signature-256 mismatch');

        $this->verifier()->assertValid(self::BODY, 'sha256=' . str_repeat('b', 64));
    }

    public function testAssertValidExplainsMissingSecret(): void
    {
        $this->expectException(WebhookRejected::class);
        $this->expectExceptionMessage('IG_APP_SECRET');

        $this->verifier('')->assertValid(self::BODY, $this->digest());
    }

    public function testAssertValidPassesSilentlyOnValidSignature(): void
    {
        $this->verifier()->assertValid(self::BODY, $this->digest());
        self::assertTrue(true);
    }

    public function testVerificationIsStableAcrossManyIterations(): void
    {
        // Cheap regression guard against accidentally re-randomising the key material.
        for ($i = 0; $i < 50; $i++) {
            $body = json_encode(['n' => $i, 'pad' => str_repeat('x', $i)]) ?: '{}';
            self::assertTrue($this->verifier()->verify($body, $this->digest($body)));
        }
    }
}
