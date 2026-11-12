<?php

declare(strict_types=1);

namespace Shortform\Repositories;

use Shortform\Domain\Interactive\DispatchJob;

/**
 * Dispatch queue contract.
 *
 * `claimReady()` must be atomic across workers. In MySQL that is
 * `SELECT ... FOR UPDATE SKIP LOCKED`, or a single
 * `UPDATE ... SET status='PENDING' WHERE status='PENDING' ORDER BY available_at LIMIT n`.
 * Two workers must never receive the same row. The interface returns already-claimed jobs so the
 * worker cannot skip the lock step.
 */
interface DispatchQueueStore
{
    /**
     * Enqueue one message. Returns null when the idempotency key already exists.
     *
     * @param array<string,mixed> $payload
     */
    public function enqueue(
        int $campaignId,
        int $eventId,
        string $channel,
        string $recipientRef,
        string $idempotencyKey,
        \DateTimeImmutable $deadline,
        array $payload,
        \DateTimeImmutable $now,
    ): ?int;

    /**
     * Atomically claim up to $limit jobs that are due at $now.
     *
     * @return list<DispatchJob>
     */
    public function claimReady(\DateTimeImmutable $now, int $limit): array;

    public function markDispatched(int $id, \DateTimeImmutable $now): void;

    public function markRetry(int $id, \DateTimeImmutable $nextAttemptAt, string $error): void;

    public function markDeadLetter(int $id, \DateTimeImmutable $now, string $error): void;

    /** @return array{pending:int, dispatched:int, deadLettered:int, settled:int} */
    public function stats(int $campaignId): array;
}
