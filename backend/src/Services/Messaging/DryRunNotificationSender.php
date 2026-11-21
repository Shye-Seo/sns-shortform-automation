<?php

declare(strict_types=1);

namespace Shortform\Services\Messaging;

use Shortform\Repositories\NotificationSender;
use Shortform\Repositories\SendResult;

/**
 * Dry-run transport: the whole pipeline runs, nothing leaves the machine.
 *
 * This is the default in local development and in the repository's end-to-end check. It is
 * deliberately visible in the ledger (`provider = dry_run`, message id prefixed `dryrun_`)
 * so a screenshot of "sent" can never be mistaken for a real Meta delivery.
 *
 * The id is derived from the message, so replaying the same dispatch produces the same id
 * and a test can assert on it without clock or randomness.
 */
final class DryRunNotificationSender implements NotificationSender
{
    public function send(string $channel, string $recipientRef, array $payload): SendResult
    {
        $seed = implode('|', [
            $channel,
            $recipientRef,
            (string) ($payload['deepLink'] ?? ''),
            (string) ($payload['commentId'] ?? ''),
        ]);

        return SendResult::delivered('dryrun_' . substr(hash('sha256', $seed), 0, 16), 0.0, 'dry_run');
    }
}
