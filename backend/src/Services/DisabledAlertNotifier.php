<?php

declare(strict_types=1);

namespace Shortform\Services;

/** No-op notifier used when SENS credentials are absent (local dev, CI, tests). */
final class DisabledAlertNotifier implements AlertNotifier
{
    public function notifyRenderCompleted(
        int $tenantId,
        string $tenantName,
        int $projectId,
        string $projectTitle,
        float $durationSec,
        string $platformLabel,
        string $recipientPhone,
    ): bool {
        return false;
    }

    public function notifyPublishCompleted(PublishJob $job, string $mediaId, ?string $permalink, string $tenantName = ''): bool
    {
        return false;
    }

    public function notifyPublishFailed(PublishJob $job, string $reason, string $hint, string $tenantName = ''): bool
    {
        return false;
    }

    public function notifyQuotaExhausted(PublishJob $job, array $quota, string $tenantName = ''): bool
    {
        return false;
    }
}
