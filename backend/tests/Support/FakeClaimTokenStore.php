<?php

declare(strict_types=1);

namespace Shortform\Tests\Support;

use Shortform\Domain\Interactive\ClaimToken;
use Shortform\Repositories\ClaimTokenStore;

/**
 * Token store fake with compare-and-set semantics.
 *
 * `claim()` must fail when the token was already claimed or already expired — the same two
 * conditions the SQL WHERE clause enforces. A fake that always succeeded would let a
 * double-click bug ship.
 */
final class FakeClaimTokenStore implements ClaimTokenStore
{
    /** @var array<int, ClaimToken> */
    private array $tokens = [];

    private int $nextId = 1;

    /** Force the next claim() to lose the race (another request won). */
    public bool $loseNextClaim = false;

    public function issue(ClaimToken $token): ?int
    {
        foreach ($this->tokens as $existing) {
            if ($existing->uuid === $token->uuid || $existing->hash === $token->hash) {
                return null;
            }
        }

        $id = $this->nextId++;
        $this->tokens[$id] = new ClaimToken(
            id: $id,
            campaignId: $token->campaignId,
            dispatchId: $token->dispatchId,
            uuid: $token->uuid,
            hash: $token->hash,
            signature: $token->signature,
            rewardAmount: $token->rewardAmount,
            isClaimed: false,
            claimCount: 0,
            claimedAt: null,
            expiresAt: $token->expiresAt,
            createdAt: $token->createdAt,
        );

        return $id;
    }

    public function findByUuid(string $uuid): ?ClaimToken
    {
        foreach ($this->tokens as $token) {
            if ($token->uuid === $uuid) {
                return $token;
            }
        }

        return null;
    }

    public function findByHash(string $hash): ?ClaimToken
    {
        foreach ($this->tokens as $token) {
            if ($token->hash === $hash) {
                return $token;
            }
        }

        return null;
    }

    public function claim(int $tokenId, \DateTimeImmutable $now, ?string $ip): bool
    {
        if ($this->loseNextClaim) {
            $this->loseNextClaim = false;

            return false;
        }

        $token = $this->tokens[$tokenId] ?? null;
        if ($token === null || $token->claimCount > 0 || $token->isExpiredAt($now)) {
            return false;
        }

        $this->tokens[$tokenId] = new ClaimToken(
            id: $token->id,
            campaignId: $token->campaignId,
            dispatchId: $token->dispatchId,
            uuid: $token->uuid,
            hash: $token->hash,
            signature: $token->signature,
            rewardAmount: $token->rewardAmount,
            isClaimed: true,
            claimCount: 1,
            claimedAt: $now,
            expiresAt: $token->expiresAt,
            createdAt: $token->createdAt,
        );

        return true;
    }

    public function findExpired(\DateTimeImmutable $now, int $limit): array
    {
        $expired = array_filter(
            $this->tokens,
            static fn (ClaimToken $token): bool => ! $token->isClaimed && $token->isExpiredAt($now),
        );

        return array_slice(array_values($expired), 0, $limit);
    }

    public function markExpired(int $tokenId): void
    {
        // 만료는 상태 컬럼을 따로 두지 않는다(expires_at으로 판정). 실 저장소도 같은 규칙이다.
    }

    /** @return list<ClaimToken> */
    public function all(): array
    {
        return array_values($this->tokens);
    }
}
