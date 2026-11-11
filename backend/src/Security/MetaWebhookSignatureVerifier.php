<?php

declare(strict_types=1);

namespace Shortform\Security;

use Shortform\Http\WebhookRejected;

/**
 * Meta Graph API webhook signature verification (X-Hub-Signature-256).
 *
 * Why this is its own service
 * ---------------------------
 * The signature check is the only thing standing between an unauthenticated POST and the
 * publish state machine. It is a security control, not a helper, so it gets:
 *
 *   - one place that defines the contract (SHA-256, header name, prefix, secret handling)
 *   - a fail-closed default when the app secret is missing
 *   - a machine-readable failure reason for logs and metrics
 *   - `hash_equals()` instead of `===`
 *
 * The timing problem
 * ------------------
 * `$expected === $received` compares byte by byte and returns at the first difference, so the
 * time to answer leaks how many leading bytes were right. An attacker can use that to forge a
 * signature byte by byte. `hash_equals()` runs in time independent of where the strings differ.
 * The comparison happens on the full digest, after normalising case and the `sha256=` prefix,
 * so a valid signature is never rejected for a formatting difference.
 *
 * What is signed
 * --------------
 * The **raw request body**, exactly as received. Decoding JSON and re-encoding it changes the
 * bytes (key order, escapes, whitespace, unicode) and the HMAC will never match. That is why
 * `Request::rawBody` is passed here and `$request->json` is never used for verification.
 *
 * Delivery is at-least-once (Meta retries for up to 24h), so this class only decides
 * authenticity; deduplication belongs to the store.
 */
final class MetaWebhookSignatureVerifier
{
    /** Header that carries the signature. Lower-cased because Request normalises header names. */
    public const HEADER = 'x-hub-signature-256';

    /** Meta's current algorithm. SHA-1 (`X-Hub-Signature`) is deprecated and rejected. */
    private const ALGORITHM = 'sha256';
    private const PREFIX = 'sha256=';
    private const LEGACY_PREFIX = 'sha1=';

    /** Reasons a check can fail. Stable strings so dashboards can group them. */
    public const REASON_MISSING_HEADER = 'missing_header';
    public const REASON_MISSING_SECRET = 'missing_app_secret';
    public const REASON_LEGACY_SHA1 = 'legacy_sha1_signature';
    public const REASON_BAD_FORMAT = 'malformed_header';
    public const REASON_MISMATCH = 'signature_mismatch';

    public function __construct(private readonly string $appSecret)
    {
    }

    /**
     * True when a secret is configured. Without it every webhook is rejected — silently
     * accepting unsigned payloads would be worse than a 403 that shows up in monitoring.
     */
    public function isConfigured(): bool
    {
        return $this->appSecret !== '';
    }

    public function verify(string $rawBody, ?string $header): bool
    {
        return $this->failureReason($rawBody, $header) === null;
    }

    /**
     * Null when the signature is valid, otherwise one of the REASON_* constants.
     * Returning the reason (instead of a bool) lets the controller log *why* it rejected,
     * and keeps "no secret configured" distinguishable from "someone is forging them".
     */
    public function failureReason(string $rawBody, ?string $header): ?string
    {
        if (!$this->isConfigured()) {
            return self::REASON_MISSING_SECRET;
        }
        if ($header === null || trim($header) === '') {
            return self::REASON_MISSING_HEADER;
        }

        $candidate = trim($header);

        // A SHA-1-only header is an explicit downgrade attempt (or a very old app config).
        if (stripos($candidate, self::LEGACY_PREFIX) === 0) {
            return self::REASON_LEGACY_SHA1;
        }

        if (stripos($candidate, self::PREFIX) !== 0) {
            return self::REASON_BAD_FORMAT;
        }

        $provided = substr($candidate, strlen(self::PREFIX));
        $expected = hash_hmac(self::ALGORITHM, $rawBody, $this->appSecret);

        // SHA-256 hex digest has a fixed length, so a different length is already a mismatch.
        // (The length of a digest is public information; only the bytes are secret.)
        if (strlen($provided) !== strlen($expected)) {
            return self::REASON_MISMATCH;
        }

        // Hex digest is case-insensitive by convention (some proxies upper-case it).
        return hash_equals($expected, strtolower($provided)) ? null : self::REASON_MISMATCH;
    }

    /** Throws the HTTP layer's rejected exception with an operator-actionable message. */
    public function assertValid(string $rawBody, ?string $header): void
    {
        $reason = $this->failureReason($rawBody, $header);
        if ($reason === null) {
            return;
        }

        throw new WebhookRejected(match ($reason) {
            self::REASON_MISSING_SECRET => 'IG_APP_SECRET is not configured; Meta webhooks cannot be verified (fail closed).',
            self::REASON_MISSING_HEADER => 'X-Hub-Signature-256 header is missing.',
            self::REASON_LEGACY_SHA1 => 'X-Hub-Signature (sha1) is not accepted; configure SHA-256 in the Meta app.',
            self::REASON_BAD_FORMAT => 'X-Hub-Signature-256 must look like "sha256=<hex digest>".',
            default => 'X-Hub-Signature-256 mismatch: check IG_APP_SECRET and that the raw body was used.',
        });
    }

    /**
     * The value Meta would send for this body. Used by tests and by the CLI when replaying a
     * captured payload locally; it is not used on the request path.
     */
    public function sign(string $rawBody): string
    {
        return self::PREFIX . hash_hmac(self::ALGORITHM, $rawBody, $this->appSecret);
    }
}
