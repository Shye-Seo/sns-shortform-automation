<?php

declare(strict_types=1);

namespace Shortform\Services;

use Shortform\Domain\Platform;

/** One publish attempt, assembled by the worker/API from a project row. */
final readonly class PublishJob
{
    /**
     * @param list<string> $hashtags
     */
    public function __construct(
        public int $tenantId,
        public int $projectId,
        public int $creatorAccountId,
        public Platform $platform,
        public string $videoUrl,
        public string $caption,
        public array $hashtags,
        public string $projectTitle,
        public string $recipientPhone,
        public ?string $approvedContentHash = null,
        public ?string $currentContentHash = null,
    ) {
    }
}
