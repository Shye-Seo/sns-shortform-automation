<?php

declare(strict_types=1);

namespace Shortform\Repositories;

use Shortform\Domain\Interactive\WebhookComment;

/**
 * Webhook event ledger.
 *
 * `record()` is the idempotency gate: one INSERT on `external_event_id` UNIQUE. It returns null
 * when the event already exists, which the dispatcher reports as DUPLICATE and answers 200 so
 * Meta stops retrying.
 *
 * Splitting "check then insert" would let two workers both see "not present" and both enqueue,
 * which is exactly the double-send this table exists to prevent.
 */
interface InteractionEventStore
{
    /**
     * @return int|null row id, or null when the event id already exists
     */
    public function record(
        int $tenantId,
        ?int $campaignId,
        WebhookComment $comment,
        string $status,
        ?string $matchedKeyword,
        bool $signatureVerified,
        ?string $rejectionReason = null,
    ): ?int;

    public function markStatus(int $id, string $status, ?string $reason = null, ?\DateTimeImmutable $now = null): void;

    /** Recent comments by the same author (hashed). Used for burst detection. */
    public function countFromAuthor(string $authorRef, \DateTimeImmutable $since): int;

    /** Recent comments from the same /24 — macro farms rotate accounts, not subnets. */
    public function countFromSubnet(string $subnet, \DateTimeImmutable $since): int;

    /** How many times the exact same body was seen recently (copy-paste spam). */
    public function countSameBody(string $normalisedBody, \DateTimeImmutable $since): int;
}
