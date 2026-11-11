<?php

declare(strict_types=1);

namespace Shortform\Services;

use Shortform\Repositories\PublishStore;
use Shortform\Support\Clock;

/**
 * Publish orchestration: quota → container → wait → publish → record → notify.
 *
 * Why an orchestrator instead of putting this in the controller: the same sequence runs
 * from the worker (scheduled publish) and from the API (manual publish), and both must
 * record the same publish_logs stages. The controller only maps HTTP in/out.
 *
 * Failure semantics
 *  - Local validation (caption, https, stale approval) throws: nothing was attempted, no
 *    quota was spent, and the caller sees an invalid request rather than a platform error.
 *  - Quota exhaustion is *not* retryable: retrying for 24 hours wastes attempts. The
 *    publish row is marked failed with code 429 and the operator gets an alimtalk.
 *  - Platform errors carry `retryable` from InstagramApiException, so the queue decides
 *    between delayed retry and DLQ instead of guessing.
 */
final class PublishOrchestrator
{
    public const ERROR_STALE_APPROVAL = 9101;
    public const ERROR_QUOTA_EXHAUSTED = 9102;

    public function __construct(
        private readonly InstagramGraphApiService $instagram,
        private readonly PublishStore $store,
        private readonly AlertNotifier $notifier,
        private readonly Clock $clock,
    ) {
    }

    public function publish(PublishJob $job): PublishOutcome
    {
        // Validate the human-written caption before merging. Truncating an over-long
        // caption would silently cut the CTA mid-sentence; reject it instead.
        $baseError = InstagramGraphApiService::captionError($job->caption);
        if ($baseError !== null) {
            throw new \InvalidArgumentException($baseError);
        }

        $caption = InstagramGraphApiService::buildCaption($job->caption, $job->hashtags);
        $mergedError = InstagramGraphApiService::captionError($caption);
        if ($mergedError !== null) {
            throw new \InvalidArgumentException($mergedError);
        }

        // Approval is a fingerprint of the exact content that a human reviewed. If the
        // script/shot changed after approval, publishing it would ship unreviewed content.
        if ($job->approvedContentHash !== null && $job->currentContentHash !== null
            && !hash_equals($job->approvedContentHash, $job->currentContentHash)) {
            throw new \DomainException('Approval is stale: content changed after review. Re-approve before publishing.');
        }

        $now = $this->clock->now();
        $publishId = $this->store->startPublish(
            $job->tenantId,
            $job->projectId,
            $job->creatorAccountId,
            $job->platform->value,
            hash('sha256', $caption),
            [
                'media_type' => 'REELS',
                'caption_length' => mb_strlen($caption),
                'video_url_host' => parse_url($job->videoUrl, PHP_URL_HOST) ?: '',
                'scheduled' => false,
            ],
            $now,
        );

        $quota = $this->instagram->getPublishingQuota();
        if ($quota['usage'] >= $quota['total']) {
            $this->store->markFailed($publishId, self::ERROR_QUOTA_EXHAUSTED, "Publishing quota exhausted ({$quota['usage']}/{$quota['total']})", $now);
            $this->notifier->notifyQuotaExhausted($job, $quota);

            return new PublishOutcome(
                status: 'failed',
                errorCode: self::ERROR_QUOTA_EXHAUSTED,
                message: "Instagram publishing quota exhausted ({$quota['usage']}/{$quota['total']})",
                retryable: false,
                detail: $quota,
            );
        }

        try {
            $containerId = $this->instagram->createReelContainer(new ReelInput(
                videoUrl: $job->videoUrl,
                caption: $caption,
            ));
            $this->store->markContainer($publishId, $containerId, $now);

            // Polling is mandatory: publishing before FINISHED fails and burns a daily slot.
            $this->instagram->waitForContainer($containerId);

            $mediaId = $this->instagram->publishContainer($containerId);
            $permalink = $this->safePermalink($mediaId);

            $this->store->markPublished(
                $publishId,
                $job->projectId,
                $mediaId,
                $permalink,
                $quota['usage'] + 1,
                $quota['total'],
                $this->clock->now(),
            );
            $this->notifier->notifyPublishCompleted($job, $mediaId, $permalink);

            return new PublishOutcome(
                status: 'published',
                mediaId: $mediaId,
                permalink: $permalink,
                detail: ['containerId' => $containerId, 'quota' => $quota],
            );
        } catch (InstagramApiException $e) {
            $this->store->markFailed($publishId, $e->metaCode, $e->getMessage() . ' ' . $e->hint, $this->clock->now());
            $this->notifier->notifyPublishFailed($job, $e->getMessage(), $e->hint);

            return new PublishOutcome(
                status: 'failed',
                errorCode: $e->metaCode,
                message: $e->getMessage(),
                retryable: $e->retryable,
                detail: ['hint' => $e->hint, 'httpStatus' => $e->httpStatus],
            );
        }
    }

    /** A missing permalink is not a publish failure: the media is live, only the URL is unknown. */
    private function safePermalink(string $mediaId): ?string
    {
        try {
            return $this->instagram->getPermalink($mediaId);
        } catch (InstagramApiException) {
            return null;
        }
    }
}
