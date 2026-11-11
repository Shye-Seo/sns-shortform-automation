<?php

declare(strict_types=1);

namespace Shortform\Services;

use Shortform\Repositories\NotificationStore;
use Shortform\Sens\AlimtalkEvent;
use Shortform\Sens\AlimtalkMessage;
use Shortform\Sens\SensConfig;
use Shortform\Sens\SensException;
use Shortform\Support\Clock;

/**
 * Notification side effects for the pipeline.
 *
 * Rule: a notification never fails the pipeline. A render that finished is finished even
 * if SENS is down; the delivery is retried from the ledger instead of re-running the video.
 * Every method therefore catches, records and returns a boolean.
 */
final class ShortformAlertNotifier implements AlertNotifier
{
    public function __construct(
        private readonly NaverCloudSensService $sens,
        private readonly NotificationStore $store,
        private readonly ShortformAlertComposer $composer,
        private readonly SensConfig $config,
        private readonly Clock $clock,
    ) {
    }

    public function notifyRenderCompleted(
        int $tenantId,
        string $tenantName,
        int $projectId,
        string $projectTitle,
        float $durationSec,
        string $platformLabel,
        string $recipientPhone,
    ): bool {
        return $this->dispatch(
            AlimtalkEvent::RenderCompleted,
            $tenantId,
            $projectId,
            $recipientPhone,
            $this->composer->renderCompleted($tenantName, $projectTitle, $durationSec, $platformLabel),
            ['project' => $projectTitle, 'duration' => $durationSec],
        );
    }

    public function notifyPublishCompleted(PublishJob $job, string $mediaId, ?string $permalink, string $tenantName = ''): bool
    {
        return $this->dispatch(
            AlimtalkEvent::PublishCompleted,
            $job->tenantId,
            $job->projectId,
            $job->recipientPhone,
            $this->composer->publishCompleted(
                $tenantName !== '' ? $tenantName : 'shortform',
                $job->projectTitle,
                $job->platform->label(),
                $permalink,
            ),
            ['media_id' => $mediaId, 'permalink' => $permalink],
        );
    }

    public function notifyPublishFailed(PublishJob $job, string $reason, string $hint, string $tenantName = ''): bool
    {
        return $this->dispatch(
            AlimtalkEvent::PublishFailed,
            $job->tenantId,
            $job->projectId,
            $job->recipientPhone,
            $this->composer->publishFailed(
                $tenantName !== '' ? $tenantName : 'shortform',
                $job->projectTitle,
                $reason,
                $hint,
            ),
            ['reason' => $reason, 'hint' => $hint],
        );
    }

    /** @param array{usage:int,total:int} $quota */
    public function notifyQuotaExhausted(PublishJob $job, array $quota, string $tenantName = ''): bool
    {
        return $this->dispatch(
            AlimtalkEvent::QuotaExhausted,
            $job->tenantId,
            $job->projectId,
            $job->recipientPhone,
            $this->composer->quotaExhausted($tenantName !== '' ? $tenantName : 'shortform', $quota),
            $quota,
        );
    }

    /** @param array<string,mixed> $payload */
    private function dispatch(
        AlimtalkEvent $event,
        int $tenantId,
        int $projectId,
        string $recipientPhone,
        string $content,
        array $payload,
    ): bool {
        $now = $this->clock->now();
        $template = $this->config->templateFor($event);

        $id = $this->store->claim(
            $tenantId,
            $projectId,
            $event->value,
            $this->composer->dedupeKey($tenantId, $projectId, $event),
            $template,
            $this->config->plusFriendId,
            $recipientPhone,
            $payload,
            $now,
        );
        if ($id === null) {
            return false; // already notified
        }

        try {
            $message = new AlimtalkMessage(
                to: $recipientPhone,
                content: $content,
                templateCode: $template,
                plusFriendId: $this->config->plusFriendId,
                failoverFrom: $this->config->failoverFrom,
                useSmsFailover: $this->config->failoverFrom !== null,
            );
            $result = $this->sens->send($message);
            $this->store->markAccepted($id, $result, $message, $this->clock->now());

            return true;
        } catch (SensException $e) {
            $this->store->markNotificationFailed($id, $e->getMessage() . ' ' . $e->hint, $this->clock->now());

            return false;
        } catch (\Throwable $e) {
            $this->store->markNotificationFailed($id, $e->getMessage(), $this->clock->now());

            return false;
        }
    }
}
