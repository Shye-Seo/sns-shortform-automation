<?php

declare(strict_types=1);

namespace Shortform\Services\Messaging;

use Shortform\Repositories\NotificationSender;
use Shortform\Repositories\SendResult;

/**
 * Channel router.
 *
 * The dispatcher only knows "INSTAGRAM_DM" or "ALIMTALK". Which provider carries each is a
 * deployment concern: local runs use the dry-run transport, production wires Meta and SENS.
 * Putting the map here keeps that switch out of the dispatcher and out of the queue.
 */
final class RoutingNotificationSender implements NotificationSender
{
    /** @param array<string,NotificationSender> $senders keyed by channel */
    public function __construct(private readonly array $senders)
    {
    }

    public function send(string $channel, string $recipientRef, array $payload): SendResult
    {
        $sender = $this->senders[$channel] ?? null;
        if ($sender === null) {
            return SendResult::permanentFailure(
                "No sender configured for channel {$channel}.",
                0.0,
                'none',
            );
        }

        return $sender->send($channel, $recipientRef, $payload);
    }
}
