<?php

declare(strict_types=1);

namespace Shortform\Domain;

/**
 * Durable queue states (mirrors src/types/queue.ts).
 * waiting → delayed → active → completed | failed → dlq.
 * `failed` is terminal only for a non-retryable error; retryable errors go back to delayed
 * with the attempt counter kept.
 */
enum JobState: string
{
    case Waiting = 'waiting';
    case Delayed = 'delayed';
    case Active = 'active';
    case Completed = 'completed';
    case Failed = 'failed';
    case Dlq = 'dlq';

    public function isTerminal(): bool
    {
        return in_array($this, [self::Completed, self::Failed, self::Dlq], true);
    }

    /** Only these states may be claimed by a worker. */
    public function isClaimable(): bool
    {
        return in_array($this, [self::Waiting, self::Delayed], true);
    }
}
