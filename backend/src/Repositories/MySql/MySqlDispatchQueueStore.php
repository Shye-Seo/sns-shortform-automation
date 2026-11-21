<?php

declare(strict_types=1);

namespace Shortform\Repositories\MySql;

use Shortform\Database\Connection;
use Shortform\Domain\Interactive\DispatchJob;
use Shortform\Repositories\DispatchQueueStore;
use Shortform\Support\DbTime;
use Shortform\Support\Env;

/**
 * Dispatch queue on dispatch_queue.
 *
 * `claimReady()` is the one method that must be right under concurrency:
 *
 *   START TRANSACTION
 *   SELECT id … WHERE (PENDING|RETRY due) OR (CLAIMED with expired lease)
 *     ORDER BY available_at, id LIMIT n
 *     FOR UPDATE SKIP LOCKED
 *   UPDATE … SET status='CLAIMED', worker_id=?, claimed_at=?, attempts=attempts+1
 *   COMMIT
 *
 * `SKIP LOCKED` lets two workers poll at the same time without waiting on each other's
 * rows; the UPDATE inside the same transaction makes the claim durable before the send
 * starts. A worker killed between CLAIM and send leaves a CLAIMED row whose lease expires,
 * and the same query picks it up again — that is the difference between "at least once"
 * and "stuck until someone notices".
 *
 * `attempts` is incremented in SQL and the job handed back carries the **previous** value,
 * so backoff never depends on how many times PHP happened to poll.
 */
final class MySqlDispatchQueueStore implements DispatchQueueStore
{
    private readonly int $leaseSeconds;

    public function __construct(
        private readonly Connection $connection,
        ?int $leaseSeconds = null,
    ) {
        $this->leaseSeconds = $leaseSeconds ?? Env::int('COUPON_WORKER_LEASE_SECONDS', 120);
    }

    public function enqueue(
        int $campaignId,
        int $eventId,
        string $channel,
        string $recipientRef,
        string $idempotencyKey,
        \DateTimeImmutable $deadline,
        array $payload,
        \DateTimeImmutable $now,
        ?\DateTimeImmutable $availableAt = null,
    ): ?int {
        $pdo = $this->connection->pdo();
        $stmt = $pdo->prepare(
            "INSERT INTO dispatch_queue
                (campaign_id, interaction_event_id, channel, recipient_ref, idempotency_key, status,
                 attempts, available_at, dispatch_deadline_at, payload, created_at, updated_at)
             VALUES
                (:campaign_id, :event_id, :channel, :recipient, :idempotency_key, 'PENDING',
                 0, :available_at, :deadline, :payload, :now_created, :now_updated)
             ON DUPLICATE KEY UPDATE id = id"
        );
        $stmt->execute([
            'campaign_id' => $campaignId,
            'event_id' => $eventId,
            'channel' => $channel,
            'recipient' => mb_substr($recipientRef, 0, 120),
            'idempotency_key' => mb_substr($idempotencyKey, 0, 120),
            'available_at' => DbTime::format($availableAt ?? $now),
            'deadline' => DbTime::format($deadline),
            'payload' => json_encode($payload, JSON_UNESCAPED_UNICODE),
            'now_created' => DbTime::format($now),
            'now_updated' => DbTime::format($now),
        ]);

        if ($stmt->rowCount() === 0) {
            return null;
        }

        return (int) $pdo->lastInsertId();
    }

    public function lastScheduledAt(int $campaignId): ?\DateTimeImmutable
    {
        $stmt = $this->connection->pdo()->prepare(
            "SELECT MAX(COALESCE(dispatched_at, available_at)) AS last_at
               FROM dispatch_queue
              WHERE campaign_id = :campaign_id
                AND status IN ('PENDING','RETRY','CLAIMED','DISPATCHED')"
        );
        $stmt->execute(['campaign_id' => $campaignId]);
        $row = $stmt->fetch();
        $value = $row === false ? null : ($row['last_at'] ?? null);

        return $value === null || $value === '' ? null : DbTime::parse((string) $value);
    }

    public function claimReady(\DateTimeImmutable $now, int $limit, ?string $workerId = null, ?int $campaignId = null): array
    {
        $limit = max(1, min(500, $limit));
        $worker = $workerId ?? (gethostname() . ':' . getmypid());
        $leaseCutoff = $now->modify('-' . $this->leaseSeconds . ' seconds');

        return $this->connection->transaction(function (\PDO $pdo) use ($now, $limit, $worker, $leaseCutoff, $campaignId): array {
            $campaignClause = $campaignId === null ? '' : ' AND campaign_id = :campaign_id';
            $select = $pdo->prepare(
                "SELECT id, campaign_id, interaction_event_id, channel, recipient_ref, idempotency_key, status, attempts, available_at, dispatch_deadline_at, created_at FROM dispatch_queue WHERE ((status IN ('PENDING','RETRY') AND available_at <= :now) OR (status = 'CLAIMED' AND claimed_at <= :lease_cutoff))"
                . $campaignClause
                . ' ORDER BY available_at, id LIMIT :limit FOR UPDATE SKIP LOCKED'
            );
            $select->bindValue('now', DbTime::format($now));
            $select->bindValue('lease_cutoff', DbTime::format($leaseCutoff));
            $select->bindValue('limit', $limit, \PDO::PARAM_INT);
            if ($campaignId !== null) {
                $select->bindValue('campaign_id', $campaignId, \PDO::PARAM_INT);
            }
            $select->execute();
            $rows = $select->fetchAll();

            if ($rows === []) {
                return [];
            }

            $update = $pdo->prepare(
                "UPDATE dispatch_queue
                    SET status = 'CLAIMED', worker_id = :worker, claimed_at = :claimed_at,
                        attempts = attempts + 1, updated_at = :updated_at
                  WHERE id = :id"
            );

            $jobs = [];
            foreach ($rows as $row) {
                $update->execute([
                    'worker' => mb_substr($worker, 0, 80),
                    'claimed_at' => DbTime::format($now),
                    'updated_at' => DbTime::format($now),
                    'id' => (int) $row['id'],
                ]);

                $jobs[] = new DispatchJob(
                    id: (int) $row['id'],
                    campaignId: (int) $row['campaign_id'],
                    eventId: (int) $row['interaction_event_id'],
                    channel: (string) $row['channel'],
                    recipientRef: (string) $row['recipient_ref'],
                    idempotencyKey: (string) $row['idempotency_key'],
                    status: 'CLAIMED',
                    // Previous value on purpose: the +1 already happened in SQL.
                    attempts: (int) $row['attempts'],
                    availableAt: DbTime::parse((string) $row['available_at']) ?? $now,
                    deadline: DbTime::parse((string) $row['dispatch_deadline_at']) ?? $now,
                    createdAt: DbTime::parse((string) $row['created_at']) ?? $now,
                );
            }

            return $jobs;
        });
    }

    public function attachToken(int $id, int $claimTokenId): void
    {
        $stmt = $this->connection->pdo()->prepare(
            'UPDATE dispatch_queue SET claim_token_id = :token_id WHERE id = :id AND claim_token_id IS NULL'
        );
        $stmt->execute(['token_id' => $claimTokenId, 'id' => $id]);
    }

    public function markDispatched(int $id, \DateTimeImmutable $now): void
    {
        $stmt = $this->connection->pdo()->prepare(
            "UPDATE dispatch_queue
                SET status = 'DISPATCHED', dispatched_at = :now, last_error = NULL, updated_at = :updated
              WHERE id = :id"
        );
        $stmt->execute([
            'now' => DbTime::format($now),
            'updated' => DbTime::format($now),
            'id' => $id,
        ]);
    }

    public function markRetry(int $id, \DateTimeImmutable $nextAttemptAt, string $error): void
    {
        $stmt = $this->connection->pdo()->prepare(
            "UPDATE dispatch_queue
                SET status = 'RETRY', available_at = :next_at, last_error = :error, updated_at = :updated
              WHERE id = :id"
        );
        $stmt->execute([
            'next_at' => DbTime::format($nextAttemptAt),
            'error' => mb_substr($error, 0, 300),
            'updated' => DbTime::now(),
            'id' => $id,
        ]);
    }

    public function markDeadLetter(int $id, \DateTimeImmutable $now, string $error): void
    {
        $stmt = $this->connection->pdo()->prepare(
            "UPDATE dispatch_queue
                SET status = 'DEAD_LETTER', dead_letter_at = :now, last_error = :error, updated_at = :updated
              WHERE id = :id"
        );
        $stmt->execute([
            'now' => DbTime::format($now),
            'error' => mb_substr($error, 0, 300),
            'updated' => DbTime::format($now),
            'id' => $id,
        ]);
    }

    /** @return array{pending:int, dispatched:int, deadLettered:int, settled:int} */
    public function stats(int $campaignId): array
    {
        $stmt = $this->connection->pdo()->prepare(
            'SELECT status, COUNT(*) AS count FROM dispatch_queue WHERE campaign_id = :campaign_id GROUP BY status'
        );
        $stmt->execute(['campaign_id' => $campaignId]);

        $stats = ['pending' => 0, 'dispatched' => 0, 'deadLettered' => 0, 'settled' => 0];
        foreach ($stmt->fetchAll() as $row) {
            $count = (int) $row['count'];
            match ((string) $row['status']) {
                'PENDING', 'CLAIMED', 'RETRY' => $stats['pending'] += $count,
                'DISPATCHED' => $stats['dispatched'] += $count,
                'DEAD_LETTER' => $stats['deadLettered'] += $count,
                default => $stats['settled'] += $count,
            };
        }

        return $stats;
    }
}
