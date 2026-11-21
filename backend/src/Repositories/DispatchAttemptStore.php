<?php

declare(strict_types=1);

namespace Shortform\Repositories;

/**
 * Send-attempt ledger.
 *
 * The queue row only holds the current state. The questions an operator actually asks —
 * "did this DM really go out, under which provider message id, and how many times did we
 * try" — need one row per attempt.
 *
 * `sentAttempt()` is the crash-safety half of idempotency: if a worker sends and then dies
 * before marking the queue row, the next worker finds the SENT row and completes the state
 * instead of sending a second DM. The UNIQUE idempotency key on dispatch_queue prevents
 * duplicate *enqueues*, not duplicate sends after a crash.
 */
interface DispatchAttemptStore
{
    /**
     * @param array<string,mixed> $requestPayload minimal body (deep link, template code) — never the full text
     */
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
    ): void;

    /** @return array<string,mixed>|null the first successful attempt for this queue row */
    public function sentAttempt(int $dispatchId): ?array;

    /** @return list<array<string,mixed>> newest first, for the operator console / E2E checks */
    public function recent(int $limit = 20): array;
}
