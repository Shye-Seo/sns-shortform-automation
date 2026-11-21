<?php

declare(strict_types=1);

namespace Shortform\Repositories\MySql;

use Shortform\Database\Connection;
use Shortform\Domain\Interactive\InteractiveCampaign;
use Shortform\Domain\Interactive\WebhookComment;
use Shortform\Repositories\InteractionEventStore;
use Shortform\Security\Pseudonymizer;
use Shortform\Support\DbTime;

/**
 * Webhook event ledger on webhook_interaction_events.
 *
 * Two details decide whether the pipeline is correct under Meta's retries:
 *
 *  1. `record()` is ONE statement with `ON DUPLICATE KEY UPDATE id = id`. `rowCount()` is 0
 *     for an existing external_event_id, and that is the only signal the dispatcher needs to
 *     report DUPLICATE and answer 200. A "SELECT then INSERT" would let two concurrent
 *     deliveries both see "absent".
 *  2. The author id is stored as a keyed HMAC. The 10 second burst check only needs equality,
 *     and a raw id in the ledger is a personal identifier with no operational use.
 *
 * `normalised_text` and `client_subnet` exist because the fraud counters run in SQL over
 * recent rows; without them `countSameBody`/`countFromSubnet` could only always return 0.
 */
final class MySqlInteractionEventStore implements InteractionEventStore
{
    private const STATUSES = ['RECEIVED', 'PARSED', 'QUEUED', 'DISPATCHED', 'IGNORED', 'REJECTED', 'DUPLICATE'];

    public function __construct(
        private readonly Connection $connection,
        private readonly Pseudonymizer $pseudonyms,
    ) {
    }

    public function record(
        int $tenantId,
        ?int $campaignId,
        WebhookComment $comment,
        string $status,
        ?string $matchedKeyword,
        bool $signatureVerified,
        ?string $rejectionReason = null,
    ): ?int {
        if (! in_array($status, self::STATUSES, true)) {
            throw new \InvalidArgumentException("Unknown interaction status: {$status}");
        }

        $pdo = $this->connection->pdo();
        $stmt = $pdo->prepare(
            'INSERT INTO webhook_interaction_events
                (campaign_id, tenant_id, platform, external_event_id, event_type, content_ref,
                 author_platform_id, author_handle, message_text, normalised_text, client_subnet,
                 matched_keyword, signature_verified, processing_status, rejection_reason, received_at, processed_at)
             VALUES
                (:campaign_id, :tenant_id, :platform, :external_event_id, :event_type, :content_ref,
                 :author_id, :author_handle, :message_text, :normalised_text, :client_subnet,
                 :matched_keyword, :signature_verified, :status, :rejection_reason, :received_at, :processed_at)
             ON DUPLICATE KEY UPDATE id = id'
        );

        $now = DbTime::format($comment->receivedAt);
        $stmt->execute([
            'campaign_id' => $campaignId,
            'tenant_id' => $tenantId,
            'platform' => $comment->platform,
            'external_event_id' => mb_substr($comment->externalEventId, 0, 120),
            'event_type' => 'comment',
            'content_ref' => mb_substr($comment->contentRef, 0, 80),
            'author_id' => $this->pseudonyms->hash($comment->authorRef),
            'author_handle' => $comment->authorHandleRef === null
                ? null
                : $this->pseudonyms->hash($comment->authorHandleRef),
            'message_text' => mb_substr($comment->text, 0, 500),
            'normalised_text' => mb_substr(InteractiveCampaign::normalise($comment->text), 0, 200),
            'client_subnet' => $comment->clientIp === null
                ? null
                : \Shortform\Services\FraudDetectionService::subnetOf($comment->clientIp),
            'matched_keyword' => $matchedKeyword === null ? null : mb_substr($matchedKeyword, 0, 40),
            'signature_verified' => $signatureVerified ? 1 : 0,
            'status' => $status,
            'rejection_reason' => $rejectionReason === null ? null : mb_substr($rejectionReason, 0, 120),
            'received_at' => $now,
            'processed_at' => $now,
        ]);

        if ($stmt->rowCount() === 0) {
            return null;
        }

        return (int) $pdo->lastInsertId();
    }

    public function markStatus(int $id, string $status, ?string $reason = null, ?\DateTimeImmutable $now = null): void
    {
        if (! in_array($status, self::STATUSES, true)) {
            throw new \InvalidArgumentException("Unknown interaction status: {$status}");
        }

        $stmt = $this->connection->pdo()->prepare(
            'UPDATE webhook_interaction_events
                SET processing_status = :status,
                    rejection_reason = COALESCE(:reason, rejection_reason),
                    processed_at = :processed_at
              WHERE id = :id'
        );
        $stmt->execute([
            'status' => $status,
            'reason' => $reason,
            'processed_at' => DbTime::format($now ?? new \DateTimeImmutable('now', DbTime::zone())),
            'id' => $id,
        ]);
    }

    public function countFromAuthor(string $authorRef, \DateTimeImmutable $since): int
    {
        return $this->count(
            'SELECT COUNT(*) FROM webhook_interaction_events WHERE author_platform_id = :value AND received_at >= :since',
            $this->pseudonyms->hash($authorRef),
            $since,
        );
    }

    public function countFromSubnet(string $subnet, \DateTimeImmutable $since): int
    {
        return $this->count(
            'SELECT COUNT(*) FROM webhook_interaction_events WHERE client_subnet = :value AND received_at >= :since',
            $subnet,
            $since,
        );
    }

    public function countSameBody(string $normalisedBody, \DateTimeImmutable $since): int
    {
        return $this->count(
            'SELECT COUNT(*) FROM webhook_interaction_events WHERE normalised_text = :value AND received_at >= :since',
            mb_substr($normalisedBody, 0, 200),
            $since,
        );
    }

    private function count(string $sql, string $value, \DateTimeImmutable $since): int
    {
        $stmt = $this->connection->pdo()->prepare($sql);
        $stmt->execute(['value' => $value, 'since' => DbTime::format($since)]);

        return (int) $stmt->fetchColumn();
    }
}
