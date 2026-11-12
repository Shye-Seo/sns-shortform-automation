<?php

declare(strict_types=1);

namespace Shortform\Security;

/**
 * HMAC-SHA256 signer for one-time claim links.
 *
 * What is signed
 * --------------
 * `"{uuid}|{expiresAt}"` (ISO-8601). The signature proves the link was minted by us; the hash of
 * the full token proves the caller holds the secret half. Both are needed:
 *   - signature alone: a database reader without the key still cannot mint a valid link
 *   - hash alone: a leaked token hash cannot be turned back into a working link
 *
 * Why `hash_equals`
 * -----------------
 * `===` short-circuits at the first differing byte, leaking how much of a forged MAC was correct.
 * That is enough to forge a MAC byte by byte. `hash_equals` compares in constant time.
 *
 * Key rotation
 * ------------
 * `verify` accepts a list of keys so a rotated key can coexist with the previous one during the
 * 15 minute TTL window. Dropping the old key instantly would invalidate every link in flight.
 */
final class HmacTokenSigner
{
    /** @var list<string> */
    private readonly array $keys;

    public function __construct(string ...$keys)
    {
        $keys = array_values(array_filter($keys, static fn (string $key): bool => $key !== ''));
        if ($keys === []) {
            throw new \InvalidArgumentException('At least one signing key is required (fail closed).');
        }
        $this->keys = $keys;
    }

    public static function payload(string $uuid, \DateTimeImmutable $expiresAt): string
    {
        return $uuid . '|' . $expiresAt->format(\DateTimeInterface::ATOM);
    }

    public function sign(string $uuid, \DateTimeImmutable $expiresAt): string
    {
        return hash_hmac('sha256', self::payload($uuid, $expiresAt), $this->keys[0]);
    }

    public function verify(string $uuid, \DateTimeImmutable $expiresAt, string $signature): bool
    {
        $payload = self::payload($uuid, $expiresAt);

        foreach ($this->keys as $key) {
            if (hash_equals(hash_hmac('sha256', $payload, $key), $signature)) {
                return true;
            }
        }

        return false;
    }

    /**
     * 32-byte secret half of the token, base64url encoded (43 chars, no padding).
     * `random_bytes` is the OS CSPRNG; `rand`/`uniqid` would make links guessable.
     */
    public function newSecret(): string
    {
        return rtrim(strtr(base64_encode(random_bytes(32)), '+/', '-_'), '=');
    }
}
