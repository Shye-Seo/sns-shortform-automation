<?php

declare(strict_types=1);

namespace Shortform\Repositories;

/**
 * Outbound message gateway (SENS alimtalk / Instagram DM).
 *
 * `retryable` is the gateway's judgement, not ours: a 429/5xx is worth another attempt, a blocked
 * recipient or an invalid phone number is not. Retrying a permanent failure burns the 5 second
 * SLA and the quota without ever succeeding.
 */
interface NotificationSender
{
    /**
     * @param array<string,mixed> $payload
     */
    public function send(string $channel, string $recipientRef, array $payload): SendResult;
}
