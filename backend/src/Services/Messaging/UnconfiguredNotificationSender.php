<?php

declare(strict_types=1);

namespace Shortform\Services\Messaging;

use Shortform\Repositories\NotificationSender;
use Shortform\Repositories\SendResult;

/**
 * A channel that is intentionally not wired yet.
 *
 * Returning a permanent failure (instead of silently succeeding or throwing) puts the job
 * in DEAD_LETTER with a readable reason. An operator sees "Meta 자격 증명 없음" in the DLQ
 * rather than a queue of rows that look sent but never left.
 */
final class UnconfiguredNotificationSender implements NotificationSender
{
    public function __construct(private readonly string $reason)
    {
    }

    public function send(string $channel, string $recipientRef, array $payload): SendResult
    {
        return SendResult::permanentFailure("Channel {$channel} is not configured: {$this->reason}", 0.0, 'unconfigured');
    }
}
