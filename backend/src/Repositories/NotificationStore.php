<?php

declare(strict_types=1);

namespace Shortform\Repositories;

use Shortform\Sens\AlimtalkMessage;
use Shortform\Sens\AlimtalkSendResult;

/**
 * Notification ledger.
 *
 * claim() is the dedupe gate: one INSERT IGNORE on a unique key. Splitting "check" and
 * "insert" into two statements lets two workers both observe "not sent yet" and send twice.
 */
interface NotificationStore
{
    /** @param array<string,mixed> $payload */
    public function claim(
        int $tenantId,
        ?int $projectId,
        string $event,
        string $dedupeKey,
        string $templateCode,
        string $plusFriendId,
        string $recipientPhone,
        array $payload,
        \DateTimeImmutable $now,
    ): ?int;

    public function markAccepted(int $id, AlimtalkSendResult $result, AlimtalkMessage $message, \DateTimeImmutable $now): void;

    public function markNotificationFailed(int $id, string $error, \DateTimeImmutable $now): void;
}
