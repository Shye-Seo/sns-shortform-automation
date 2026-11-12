<?php

declare(strict_types=1);

namespace Shortform\Domain\Interactive;

/**
 * One-time claim token (the tail of the deep link).
 *
 * Stored fields are deliberately lossy: `uuid` is the public lookup key, `hash` is SHA-256 of
 * the full token, and `signature` is an HMAC over `uuid|expiresAt`. The plaintext token is shown
 * once in the dispatch message and never persisted, so a database dump cannot be replayed into
 * working links.
 *
 * `claimCount` is the compare-and-set guard: claiming runs
 * `UPDATE ... WHERE claim_count = 0`, so two simultaneous clicks cannot both succeed — even on
 * different app servers.
 */
final class ClaimToken
{
    public function __construct(
        public readonly int $id,
        public readonly int $campaignId,
        public readonly ?int $dispatchId,
        public readonly string $uuid,
        public readonly string $hash,
        public readonly string $signature,
        public readonly int $rewardAmount,
        public readonly bool $isClaimed,
        public readonly int $claimCount,
        public readonly ?\DateTimeImmutable $claimedAt,
        public readonly \DateTimeImmutable $expiresAt,
        public readonly \DateTimeImmutable $createdAt,
    ) {
    }

    public function isExpiredAt(\DateTimeImmutable $now): bool
    {
        return $now >= $this->expiresAt;
    }

    public function isUsableAt(\DateTimeImmutable $now): bool
    {
        return ! $this->isClaimed && $this->claimCount === 0 && ! $this->isExpiredAt($now);
    }
}
