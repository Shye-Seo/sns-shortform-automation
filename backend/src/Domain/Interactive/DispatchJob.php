<?php

declare(strict_types=1);

namespace Shortform\Domain\Interactive;

/**
 * Dispatch queue row (one message to one recipient).
 *
 * The 5 second SLA lives on this object as `deadline`. A worker that picks up a job after the
 * deadline must not send it late and pretend it succeeded: a coupon that arrives after the user
 * already left the app is worse than no coupon, because it burns support time. Late jobs go to
 * DEAD_LETTER where an operator can see them.
 */
final class DispatchJob
{
    public function __construct(
        public readonly int $id,
        public readonly int $campaignId,
        public readonly int $eventId,
        public readonly string $channel,
        public readonly string $recipientRef,
        public readonly string $idempotencyKey,
        public readonly string $status,
        public readonly int $attempts,
        public readonly \DateTimeImmutable $availableAt,
        public readonly \DateTimeImmutable $deadline,
        public readonly \DateTimeImmutable $createdAt,
    ) {
    }

    public function isPastDeadline(\DateTimeImmutable $now): bool
    {
        return $now > $this->deadline;
    }

    /** Exponential backoff: 1s, 2s, 4s, 8s … capped at 30s. */
    public function backoffSeconds(): int
    {
        return min(30, 2 ** max(0, $this->attempts - 1));
    }
}
