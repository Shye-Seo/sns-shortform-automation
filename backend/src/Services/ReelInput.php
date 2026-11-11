<?php

declare(strict_types=1);

namespace Shortform\Services;

/** What goes into a Reels container. The video itself must already be a public HTTPS URL. */
final readonly class ReelInput
{
    public function __construct(
        public string $videoUrl,
        public string $caption,
        public ?string $coverUrl = null,
        public ?int $thumbOffsetMs = null,
        public bool $shareToFeed = true,
        public ?\DateTimeImmutable $scheduleAt = null,
    ) {
    }
}
