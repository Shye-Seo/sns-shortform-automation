<?php

declare(strict_types=1);

namespace Shortform\Repositories;

/**
 * Durable queue contract.
 *
 * claimNext() must be atomic across workers: it returns a job only to one caller even when
 * ten workers poll at the same millisecond. The MySQL implementation does that with
 * `SELECT … FOR UPDATE SKIP LOCKED` inside a transaction.
 */
interface JobQueueStore
{
    /** @param array<string,mixed> $payload */
    public function enqueue(
        int $tenantId,
        int $projectId,
        string $platform,
        int $priority,
        array $payload,
        ?string $dedupeKey,
        \DateTimeImmutable $now,
    ): int;

    /**
     * @return array<string,mixed>|null the claimed job row, or null when the queue is empty
     */
    public function claimNext(
        string $workerId,
        int $leaseSeconds,
        ?int $tenantId,
        \DateTimeImmutable $now,
    ): ?array;

    public function updateProgress(int $jobId, float $progress, \DateTimeImmutable $now): void;

    /** @param array<string,mixed> $result */
    public function complete(int $jobId, array $result, string $outputPath, \DateTimeImmutable $now): void;

    public function fail(int $jobId, string $error, bool $retryable, \DateTimeImmutable $now): void;

    /** Return count of jobs recovered from dead workers. */
    public function reclaimStalled(int $limit, \DateTimeImmutable $now): int;

    /** @return array<string,int> state => count */
    public function countsByState(int $tenantId): array;
}
