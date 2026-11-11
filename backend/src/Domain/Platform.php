<?php

declare(strict_types=1);

namespace Shortform\Domain;

/** Publish target. Both are 9:16, but their ceilings differ (90s vs 60s, 25/day vs 6/day). */
enum Platform: string
{
    case InstagramReels = 'instagram-reels';
    case YouTubeShorts = 'youtube-shorts';

    public function label(): string
    {
        return match ($this) {
            self::InstagramReels => 'Instagram Reels',
            self::YouTubeShorts => 'YouTube Shorts',
        };
    }

    public function maxDurationSec(): int
    {
        return $this === self::InstagramReels ? 90 : 60;
    }

    /** API-published posts allowed in a rolling 24h window. */
    public function dailyPublishLimit(): int
    {
        return $this === self::InstagramReels ? 25 : 6;
    }
}
