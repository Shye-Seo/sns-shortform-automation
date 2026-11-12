<?php

declare(strict_types=1);

namespace Shortform\Tests\Support;

use Shortform\Domain\Interactive\WebhookComment;
use Shortform\Repositories\InteractionEventStore;

/**
 * Interaction event store fake with real uniqueness semantics.
 *
 * The DB enforces `external_event_id` UNIQUE. The fake must do the same, otherwise a test that
 * claims "duplicate webhooks do not enqueue twice" would pass for the wrong reason.
 */
final class FakeInteractionEventStore implements InteractionEventStore
{
    /** @var array<string, array<string,mixed>> */
    private array $events = [];

    /** @var array<string,int> signal overrides: author/subnet/body => count */
    public array $authorCounts = [];

    public array $subnetCounts = [];

    public array $bodyCounts = [];

    private int $nextId = 1;

    public function record(
        int $tenantId,
        ?int $campaignId,
        WebhookComment $comment,
        string $status,
        ?string $matchedKeyword,
        bool $signatureVerified,
        ?string $rejectionReason = null,
    ): ?int {
        if (isset($this->events[$comment->externalEventId])) {
            return null;
        }

        $id = $this->nextId++;
        $this->events[$comment->externalEventId] = [
            'id' => $id,
            'tenantId' => $tenantId,
            'campaignId' => $campaignId,
            'status' => $status,
            'keyword' => $matchedKeyword,
            'signatureVerified' => $signatureVerified,
            'rejectionReason' => $rejectionReason,
            'author' => $comment->authorRef,
            'text' => $comment->text,
        ];

        return $id;
    }

    public function markStatus(int $id, string $status, ?string $reason = null, ?\DateTimeImmutable $now = null): void
    {
        foreach ($this->events as $eventId => $event) {
            if ($event['id'] === $id) {
                $this->events[$eventId]['status'] = $status;
                $this->events[$eventId]['rejectionReason'] = $reason;

                return;
            }
        }
    }

    public function countFromAuthor(string $authorRef, \DateTimeImmutable $since): int
    {
        return $this->authorCounts[$authorRef] ?? 0;
    }

    public function countFromSubnet(string $subnet, \DateTimeImmutable $since): int
    {
        return $this->subnetCounts[$subnet] ?? 0;
    }

    public function countSameBody(string $normalisedBody, \DateTimeImmutable $since): int
    {
        return $this->bodyCounts[$normalisedBody] ?? 0;
    }

    /** @return array<string,mixed>|null */
    public function find(string $externalEventId): ?array
    {
        return $this->events[$externalEventId] ?? null;
    }

    public function count(): int
    {
        return count($this->events);
    }
}
