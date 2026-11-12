<?php

declare(strict_types=1);

namespace Shortform\Repositories;

use Shortform\Domain\Interactive\InteractiveCampaign;

/**
 * Campaign lookup by content.
 *
 * The webhook path has no campaign id — it only has a comment on a media id. So the hot lookup is
 * `(platform, contentRef, now)` and it must hit `idx_interactive_campaigns_content`. Returning
 * null is a normal outcome (a comment on a post that is not ours), not an error.
 */
interface CampaignCatalog
{
    public function findById(int $campaignId): ?InteractiveCampaign;

    public function findLiveByContent(string $platform, string $contentRef, \DateTimeImmutable $now): ?InteractiveCampaign;

    /**
     * How much of the budget has been consumed so far.
     *
     * @return array{claims:int, rewardTotal:int}
     */
    public function usage(int $campaignId): array;
}
