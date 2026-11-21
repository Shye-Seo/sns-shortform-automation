<?php

declare(strict_types=1);

namespace Shortform\Repositories;

use Shortform\Domain\Interactive\DispatchJob;

/**
 * Dispatch queue contract.
 *
 * `claimReady()` must be atomic across workers. In MySQL that is
 * `SELECT ... FOR UPDATE SKIP LOCKED`, followed by an UPDATE that marks the row
 * `CLAIMED` with the worker id and a lease timestamp. Two workers must never receive the
 * same row, and a worker that dies mid-send must not strand it: a `CLAIMED` row whose
 * lease expired is claimable again.
 *
 * The returned job carries the attempts count **before** this claim, so retry backoff is
 * computed from the same number in the fake and in MySQL.
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
     * `$campaignId` narrows the claim to one campaign. It exists for isolating a
     * noisy campaign or a test from the rest of the queue; the default (null) is the global
     * worker that production runs.
     *
     * @return list<DispatchJob>
     */
    public function claimReady(
        \DateTimeImmutable $now,
        int $limit,
        ?string $workerId = null,
        ?int $campaignId = null,
    ): array;

    /** Link the one-time token that was minted for this job (nullable until the worker runs). */
    public function attachToken(int $id, int $claimTokenId): void;

    public function markDispatched(int $id, \DateTimeImmutable $now): void;

    public function markRetry(int $id, \DateTimeImmutable $nextAttemptAt, string $error): void;

    public function markDeadLetter(int $id, \DateTimeImmutable $now, string $error): void;

    /** @return array{pending:int, dispatched:int, deadLettered:int, settled:int} */
    public function stats(int $campaignId): array;
}
