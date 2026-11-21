<?php

declare(strict_types=1);

namespace Shortform\Repositories\MySql;

use Shortform\Database\Connection;
use Shortform\Domain\Interactive\ClaimToken;
use Shortform\Repositories\ClaimTokenStore;
use Shortform\Support\DbTime;

/**
 * One-time claim tokens on instant_claim_tokens.
 *
 * `claim()` is a compare-and-set, not a read-then-write:
 *
 *   UPDATE instant_claim_tokens
 *      SET is_claimed = 1, claim_count = 1, claimed_at = ?, claimed_ip = INET6_ATON(?)
 *    WHERE id = ? AND claim_count = 0 AND is_claimed = 0 AND expires_at > ?
 *
 * Exactly one concurrent request affects a row; the other gets 0 and is told "already
 * used". Doing the check in PHP would let two app servers both read claim_count=0.
 *
 * The plaintext token is never stored: lookup is by SHA-256 of the presented token, and the
 * HMAC signature proves the server minted it. A database dump therefore cannot be replayed
 * into working links.
 */
final class MySqlClaimTokenStore implements ClaimTokenStore
{
    private const COLUMNS = 'id, campaign_id, dispatch_queue_id, token_uuid, token_hash, hmac_signature,
        reward_amount, is_claimed, claim_count, claimed_at, expires_at, created_at';

    public function __construct(private readonly Connection $connection)
    {
    }

    public function issue(ClaimToken $token): ?int
    {
        $pdo = $this->connection->pdo();
        $stmt = $pdo->prepare(
            'INSERT INTO instant_claim_tokens
                (campaign_id, dispatch_queue_id, token_uuid, token_hash, hmac_signature, reward_amount,
                 is_claimed, claim_count, claimed_at, expires_at, created_at)
             VALUES
                (:campaign_id, :dispatch_id, :uuid, :hash, :signature, :reward,
                 0, 0, NULL, :expires_at, :created_at)
             ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)'
        );
        $stmt->execute([
            'campaign_id' => $token->campaignId,
            'dispatch_id' => $token->dispatchId,
            'uuid' => $token->uuid,
            'hash' => $token->hash,
            'signature' => $token->signature,
            'reward' => $token->rewardAmount,
            'expires_at' => DbTime::format($token->expiresAt),
            'created_at' => DbTime::format($token->createdAt),
        ]);

        $id = (int) $pdo->lastInsertId();

        return $id > 0 ? $id : null;
    }

    public function findByUuid(string $uuid): ?ClaimToken
    {
        return $this->findOne('token_uuid = :value', $uuid);
    }

    public function findByHash(string $hash): ?ClaimToken
    {
        return $this->findOne('token_hash = :value', $hash);
    }

    public function claim(int $tokenId, \DateTimeImmutable $now, ?string $ip): bool
    {
        $stmt = $this->connection->pdo()->prepare(
            'UPDATE instant_claim_tokens
                SET is_claimed = 1,
                    claim_count = 1,
                    claimed_at = :claimed_at,
                    claimed_ip = CASE WHEN :ip IS NULL THEN NULL ELSE INET6_ATON(:ip_value) END
              WHERE id = :id
                AND claim_count = 0
                AND is_claimed = 0
                AND expires_at > :now'
        );
        $stmt->execute([
            'claimed_at' => DbTime::format($now),
            'ip' => $ip,
            'ip_value' => $ip,
            'id' => $tokenId,
            'now' => DbTime::format($now),
        ]);

        return $stmt->rowCount() === 1;
    }

    /** @return list<ClaimToken> */
    public function findExpired(\DateTimeImmutable $now, int $limit): array
    {
        $stmt = $this->connection->pdo()->prepare(
            'SELECT ' . self::COLUMNS . ' FROM instant_claim_tokens
              WHERE is_claimed = 0 AND expired_at IS NULL AND expires_at <= :now
              ORDER BY expires_at
              LIMIT :limit'
        );
        $stmt->bindValue('now', DbTime::format($now));
        $stmt->bindValue('limit', max(1, $limit), \PDO::PARAM_INT);
        $stmt->execute();

        return array_map(self::hydrate(...), $stmt->fetchAll());
    }

    public function markExpired(int $tokenId): void
    {
        $stmt = $this->connection->pdo()->prepare(
            'UPDATE instant_claim_tokens SET expired_at = COALESCE(expired_at, :now) WHERE id = :id'
        );
        $stmt->execute(['now' => DbTime::now(), 'id' => $tokenId]);
    }

    private function findOne(string $condition, string $value): ?ClaimToken
    {
        $stmt = $this->connection->pdo()->prepare(
            'SELECT ' . self::COLUMNS . ' FROM instant_claim_tokens WHERE ' . $condition . ' LIMIT 1'
        );
        $stmt->execute(['value' => $value]);
        $row = $stmt->fetch();

        return $row === false ? null : self::hydrate($row);
    }

    /** @param array<string,mixed> $row */
    private static function hydrate(array $row): ClaimToken
    {
        return new ClaimToken(
            id: (int) $row['id'],
            campaignId: (int) $row['campaign_id'],
            dispatchId: $row['dispatch_queue_id'] === null ? null : (int) $row['dispatch_queue_id'],
            uuid: (string) $row['token_uuid'],
            hash: (string) $row['token_hash'],
            signature: (string) $row['hmac_signature'],
            rewardAmount: (int) $row['reward_amount'],
            isClaimed: (bool) $row['is_claimed'],
            claimCount: (int) $row['claim_count'],
            claimedAt: DbTime::parse($row['claimed_at'] === null ? null : (string) $row['claimed_at']),
            expiresAt: DbTime::parse((string) $row['expires_at']) ?? new \DateTimeImmutable('now'),
            createdAt: DbTime::parse((string) $row['created_at']) ?? new \DateTimeImmutable('now'),
        );
    }
}
