<?php

declare(strict_types=1);

namespace Shortform\Tests\Support;

use Shortform\Repositories\DispatchAttemptStore;
use Shortform\Repositories\SendResult;

/** In-memory attempt ledger with the same "a SENT row proves delivery" rule as MySQL. */
final class FakeDispatchAttemptStore implements DispatchAttemptStore
{
    /** @var list<array<string,mixed>> */
    public array $rows = [];

    public function record(
        int $dispatchId,
        int $campaignId,
        ?int $claimTokenId,
        string $channel,
        string $provider,
        int $attemptNo,
        string $recipientRef,
        SendResult $result,
        array $requestPayload,
        \DateTimeImmutable $now,
    ): void {
        $this->rows[] = [
            'dispatchId' => $dispatchId,
            'campaignId' => $campaignId,
            'claimTokenId' => $claimTokenId,
            'channel' => $channel,
            'provider' => $provider,
            'attemptNo' => $attemptNo,
            'recipientRef' => $recipientRef,
            'outcome' => $result->outcome(),
            'messageId' => $result->messageId,
            'error' => $result->error,
            'latencyMs' => $result->latencyMs,
            'payload' => $requestPayload,
            'at' => $now,
        ];
    }

    public function sentAttempt(int $dispatchId): ?array
    {
        foreach ($this->rows as $row) {
            if ($row['dispatchId'] === $dispatchId && $row['outcome'] === 'SENT') {
                return $row;
            }
        }

        return null;
    }

    /** @return list<array<string,mixed>> */
    public function recent(int $limit = 20): array
    {
        return array_slice(array_reverse($this->rows), 0, $limit);
    }

    public function count(): int
    {
        return count($this->rows);
    }
}
