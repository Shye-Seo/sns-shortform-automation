<?php

declare(strict_types=1);

namespace Shortform\Security;

/**
 * Keyed pseudonym for platform identifiers.
 *
 * `webhook_interaction_events.author_platform_id` is CHAR(64) and documented as an HMAC,
 * not the raw Instagram user id: the ledger only needs "same person or not" for burst and
 * duplicate detection, and a raw id in a log table is a personal identifier with no product
 * need. A plain SHA-256 would be reversible by enumerating the small numeric id space, so
 * the digest is keyed.
 *
 * Rotating the key resets historical grouping (old rows no longer match new hashes). That
 * is acceptable for a 10 second abuse window; if that ever changes, store a key version.
 */
final class Pseudonymizer
{
    public function __construct(private readonly string $key)
    {
        if ($this->key === '') {
            throw new \InvalidArgumentException('A pseudonymisation key is required (fail closed).');
        }
    }

    public function hash(string $value): string
    {
        return hash_hmac('sha256', $value, $this->key);
    }
}
