<?php

declare(strict_types=1);

namespace Shortform\Tests\Support;

use Shortform\Repositories\PublishStore;
use Shortform\Repositories\WebhookApplyResult;

/** Records the publish lifecycle; returns configurable webhook dedupe results. */
final class FakePublishStore implements PublishStore
{
    /** @var list<array<string,mixed>> */
    public array $calls = [];

    /** @var list<array<string,mixed>> */
    public array $webhooks = [];

    public int $publishId = 41;
    public WebhookApplyResult $webhookResult = WebhookApplyResult::Applied;

    public function startPublish(
        int $tenantId,
        int $projectId,
        int $creatorAccountId,
        string $platform,
        string $captionHash,
        array $requestPayload,
        \DateTimeImmutable $now,
    ): int {
        $this->calls[] = compact('tenantId', 'projectId', 'creatorAccountId', 'platform', 'captionHash', 'requestPayload');

        return $this->publishId;
    }

    public function markContainer(int $publishId, string $containerId, \DateTimeImmutable $now): void
    {
        $this->calls[] = ['markContainer', $publishId, $containerId];
    }

    public function markPublished(
        int $publishId,
        int $projectId,
        string $mediaId,
        ?string $permalink,
        int $quotaUsed,
        int $quotaTotal,
        \DateTimeImmutable $now,
    ): void {
        $this->calls[] = ['markPublished', $publishId, $projectId, $mediaId, $permalink, $quotaUsed, $quotaTotal];
    }

    public function markFailed(int $publishId, ?int $errorCode, string $message, \DateTimeImmutable $now): void
    {
        $this->calls[] = ['markFailed', $publishId, $errorCode, $message];
    }

    public function applyWebhookEvent(
        string $mediaId,
        string $eventId,
        string $status,
        array $rawEvent,
        \DateTimeImmutable $now,
    ): WebhookApplyResult {
        $this->webhooks[] = compact('mediaId', 'eventId', 'status', 'rawEvent');

        return $this->webhookResult;
    }

    /** @return list<string> call names in order */
    public function callNames(): array
    {
        return array_map(
            static fn (array $call): string => is_string($call[0] ?? null) ? $call[0] : 'startPublish',
            $this->calls,
        );
    }
}
