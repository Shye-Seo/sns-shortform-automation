<?php

declare(strict_types=1);

namespace Shortform\Services;

/**
 * Notification side-effect boundary.
 *
 * The orchestrator/worker do not care whether SENS is configured. When it is not, a
 * DisabledAlertNotifier is injected and every call is a no-op that returns false, so the
 * pipeline runs identically in development without credentials.
 */
interface AlertNotifier
{
    public function notifyRenderCompleted(
        int $tenantId,
        string $tenantName,
        int $projectId,
        string $projectTitle,
        float $durationSec,
        string $platformLabel,
        string $recipientPhone,
    ): bool;

    public function notifyPublishCompleted(PublishJob $job, string $mediaId, ?string $permalink, string $tenantName = ''): bool;

    public function notifyPublishFailed(PublishJob $job, string $reason, string $hint, string $tenantName = ''): bool;

    /** @param array{usage:int,total:int} $quota */
    public function notifyQuotaExhausted(PublishJob $job, array $quota, string $tenantName = ''): bool;
}
