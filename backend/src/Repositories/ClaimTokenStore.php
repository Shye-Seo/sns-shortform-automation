<?php

declare(strict_types=1);

namespace Shortform\Repositories;

use Shortform\Domain\Interactive\ClaimToken;

/**
 * One-time token store.
 *
 * `claim()` is compare-and-set:
 * `UPDATE instant_claim_tokens SET is_claimed=1, claim_count=1, claimed_at=?, claimed_ip=?
 *  WHERE id=? AND claim_count=0 AND expires_at > ?`.
 * Exactly one concurrent caller gets affected-rows 1; the others get 0 and must be told "already
 * used" rather than "invalid".
 */
interface ClaimTokenStore
{
    public function issue(ClaimToken $token): ?int;

    public function findByUuid(string $uuid): ?ClaimToken;

    public function findByHash(string $hash): ?ClaimToken;

    public function claim(int $tokenId, \DateTimeImmutable $now, ?string $ip): bool;

    /** @return list<ClaimToken> */
    public function findExpired(\DateTimeImmutable $now, int $limit): array;

    public function markExpired(int $tokenId): void;
}
