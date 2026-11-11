<?php

declare(strict_types=1);

namespace Shortform\Repositories;

/**
 * Publish persistence contract.
 *
 * Kept narrow on purpose: the orchestrator and the webhook controller need to *record*
 * what happened, and tests need to assert the sequence without MySQL. The concrete
 * implementation (ShortformRepository) owns the SQL.
 */
interface PublishStore
{
    /** @param array<string,mixed> $requestPayload */
    public function startPublish(
        int $tenantId,
        int $projectId,
        int $creatorAccountId,
        string $platform,
        string $captionHash,
        array $requestPayload,
        \DateTimeImmutable $now,
    ): int;

    public function markContainer(int $publishId, string $containerId, \DateTimeImmutable $now): void;

    public function markPublished(
        int $publishId,
        int $projectId,
        string $mediaId,
        ?string $permalink,
        int $quotaUsed,
        int $quotaTotal,
        \DateTimeImmutable $now,
    ): void;

    public function markFailed(int $publishId, ?int $errorCode, string $message, \DateTimeImmutable $now): void;

    /**
     * Apply a platform webhook.
     *
     * @param array<string,mixed> $rawEvent
     */
    public function applyWebhookEvent(
        string $mediaId,
        string $eventId,
        string $status,
        array $rawEvent,
        \DateTimeImmutable $now,
    ): WebhookApplyResult;
}
