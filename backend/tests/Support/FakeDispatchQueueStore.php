<?php

declare(strict_types=1);

namespace Shortform\Tests\Support;

use Shortform\Domain\Interactive\DispatchJob;
use Shortform\Repositories\DispatchQueueStore;

/**
 * In-memory dispatch queue.
 *
 * `claimReady()` increments `attempts`, exactly like the SQL claim does, so retry/backoff
 * behaviour is exercised rather than assumed. Jobs are returned in `available_at` order, and
 * only when they are due — a queue that hands out future work would hide a backoff bug.
 */
final class FakeDispatchQueueStore implements DispatchQueueStore
{
    /** @var array<int, array<string,mixed>> */
    private array $rows = [];

    private int $nextId = 1;

    private int $sequence = 0;

    public function enqueue(
        int $campaignId,
        int $eventId,
        string $channel,
        string $recipientRef,
        string $idempotencyKey,
        \DateTimeImmutable $deadline,
        array $payload,
        \DateTimeImmutable $now,
    ): ?int {
        foreach ($this->rows as $row) {
            if ($row['idempotencyKey'] === $idempotencyKey) {
                return null;
            }
        }

        $id = $this->nextId++;
        $this->rows[$id] = [
            'id' => $id,
            'campaignId' => $campaignId,
            'eventId' => $eventId,
            'channel' => $channel,
            'recipientRef' => $recipientRef,
            'idempotencyKey' => $idempotencyKey,
            'status' => 'PENDING',
            'attempts' => 0,
            'availableAt' => $now,
            'deadline' => $deadline,
            'createdAt' => $now,
            'payload' => $payload,
            'lastError' => null,
            'order' => $this->sequence++,
        ];

        return $id;
    }

    public function claimReady(\DateTimeImmutable $now, int $limit): array
    {
        $due = array_values(array_filter($this->rows, static function (array $row) use ($now): bool {
            $active = $row['status'] === 'PENDING' || $row['status'] === 'RETRY';

            return $active && $row['availableAt'] <= $now;
        }));

        usort($due, static fn (array $a, array $b): int => [$a['availableAt'], $a['order']] <=> [$b['availableAt'], $b['order']]);

        $claimed = [];
        foreach (array_slice($due, 0, $limit) as $row) {
            $this->rows[$row['id']]['status'] = 'CLAIMED';
            $this->rows[$row['id']]['attempts'] = $row['attempts'] + 1;

            $claimed[] = new DispatchJob(
                id: $row['id'],
                campaignId: $row['campaignId'],
                eventId: $row['eventId'],
                channel: $row['channel'],
                recipientRef: $row['recipientRef'],
                idempotencyKey: $row['idempotencyKey'],
                status: 'CLAIMED',
                attempts: $row['attempts'],
                availableAt: $row['availableAt'],
                deadline: $row['deadline'],
                createdAt: $row['createdAt'],
            );
        }

        return $claimed;
    }

    public function markDispatched(int $id, \DateTimeImmutable $now): void
    {
        $this->rows[$id]['status'] = 'DISPATCHED';
        $this->rows[$id]['dispatchedAt'] = $now;
    }

    public function markRetry(int $id, \DateTimeImmutable $nextAttemptAt, string $error): void
    {
        $this->rows[$id]['status'] = 'RETRY';
        $this->rows[$id]['availableAt'] = $nextAttemptAt;
        $this->rows[$id]['lastError'] = $error;
    }

    public function markDeadLetter(int $id, \DateTimeImmutable $now, string $error): void
    {
        $this->rows[$id]['status'] = 'DEAD_LETTER';
        $this->rows[$id]['lastError'] = $error;
        $this->rows[$id]['deadLetterAt'] = $now;
    }

    public function stats(int $campaignId): array
    {
        $stats = ['pending' => 0, 'dispatched' => 0, 'deadLettered' => 0, 'settled' => 0];
        foreach ($this->rows as $row) {
            if ($row['campaignId'] !== $campaignId) {
                continue;
            }
            match ($row['status']) {
                'PENDING', 'RETRY', 'CLAIMED' => $stats['pending']++,
                'DISPATCHED' => $stats['dispatched']++,
                'DEAD_LETTER' => $stats['deadLettered']++,
                default => $stats['settled']++,
            };
        }

        return $stats;
    }

    /** @return array<string,mixed> */
    public function row(int $id): array
    {
        return $this->rows[$id];
    }

    public function count(): int
    {
        return count($this->rows);
    }
}
