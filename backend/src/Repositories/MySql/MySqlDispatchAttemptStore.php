<?php

declare(strict_types=1);

namespace Shortform\Repositories\MySql;

use Shortform\Database\Connection;
use Shortform\Repositories\DispatchAttemptStore;
use Shortform\Repositories\SendResult;
use Shortform\Support\DbTime;

/**
 * Send-attempt ledger on dispatch_attempts.
 *
 * Every attempt is written, success or failure. The SENT row is what makes the worker
 * crash-safe: a worker that sends and dies before `markDispatched` leaves a CLAIMED row and
 * a SENT attempt; the next worker sees the attempt and finishes the state instead of
 * sending a second DM. `idempotency_key` only protects enqueue, not that window.
 */
final class MySqlDispatchAttemptStore implements DispatchAttemptStore
{
    public function __construct(private readonly Connection $connection)
    {
    }

    public function record(
        int $dispatchId,
        int $campaignId,
        ?int $claimTokenId,
        string $channel,
        string $provider,
        int $attemptNo,
        string $recipientRef,
        SendResult $result,
        array $requestPayload,
        \DateTimeImmutable $now,
    ): void {
        $stmt = $this->connection->pdo()->prepare(
            'INSERT INTO dispatch_attempts
                (dispatch_queue_id, campaign_id, claim_token_id, channel, provider, attempt_no,
                 recipient_ref, outcome, provider_message_id, error_message, latency_ms, request_payload, created_at)
             VALUES
                (:dispatch_id, :campaign_id, :token_id, :channel, :provider, :attempt_no,
                 :recipient, :outcome, :message_id, :error, :latency, :payload, :created_at)'
        );
        $stmt->execute([
            'dispatch_id' => $dispatchId,
            'campaign_id' => $campaignId,
            'token_id' => $claimTokenId,
            'channel' => $channel,
            'provider' => mb_substr($provider === '' ? 'unknown' : $provider, 0, 24),
            'attempt_no' => max(1, min(255, $attemptNo)),
            'recipient' => mb_substr($recipientRef, 0, 120),
            'outcome' => $result->outcome(),
            'message_id' => $result->messageId === null ? null : mb_substr($result->messageId, 0, 80),
            'error' => $result->error === '' ? null : mb_substr($result->error, 0, 300),
            'latency' => round($result->latencyMs, 1),
            'payload' => json_encode($requestPayload, JSON_UNESCAPED_UNICODE),
            'created_at' => DbTime::format($now),
        ]);
    }

    /** @return array<string,mixed>|null */
    public function sentAttempt(int $dispatchId): ?array
    {
        $stmt = $this->connection->pdo()->prepare(
            "SELECT id, provider, provider_message_id, created_at
               FROM dispatch_attempts
              WHERE dispatch_queue_id = :dispatch_id AND outcome = 'SENT'
              ORDER BY id
              LIMIT 1"
        );
        $stmt->execute(['dispatch_id' => $dispatchId]);
        $row = $stmt->fetch();

        return $row === false ? null : $row;
    }

    /** @return list<array<string,mixed>> */
    public function recent(int $limit = 20): array
    {
        $stmt = $this->connection->pdo()->prepare(
            'SELECT id, dispatch_queue_id, campaign_id, claim_token_id, channel, provider, attempt_no,
                    recipient_ref, outcome, provider_message_id, error_message, latency_ms, created_at
               FROM dispatch_attempts
              ORDER BY id DESC
              LIMIT :limit'
        );
        $stmt->bindValue('limit', max(1, min(200, $limit)), \PDO::PARAM_INT);
        $stmt->execute();

        return $stmt->fetchAll();
    }
}
