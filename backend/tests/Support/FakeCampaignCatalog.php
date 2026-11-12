<?php

declare(strict_types=1);

namespace Shortform\Tests\Support;

use Shortform\Domain\Interactive\InteractiveCampaign;
use Shortform\Repositories\CampaignCatalog;

/**
 * Campaign catalog fake.
 *
 * Lets a test decide exactly what "our post" means, and lets the budget be manipulated without a
 * database. Budget is the interesting part: a campaign that has already spent its budget must
 * stop enqueueing even when the keyword matches.
 */
final class FakeCampaignCatalog implements CampaignCatalog
{
    /** @var array<int, InteractiveCampaign> */
    private array $campaigns = [];

    /** @var array<int, array{claims:int, rewardTotal:int}> */
    private array $usage = [];

    public function add(InteractiveCampaign $campaign): self
    {
        $this->campaigns[$campaign->id] = $campaign;

        return $this;
    }

    public function setUsage(int $campaignId, int $claims, int $rewardTotal): void
    {
        $this->usage[$campaignId] = ['claims' => $claims, 'rewardTotal' => $rewardTotal];
    }

    public function findById(int $campaignId): ?InteractiveCampaign
    {
        return $this->campaigns[$campaignId] ?? null;
    }

    public function findLiveByContent(string $platform, string $contentRef, \DateTimeImmutable $now): ?InteractiveCampaign
    {
        foreach ($this->campaigns as $campaign) {
            if ($campaign->platform === $platform
                && $campaign->contentRef === $contentRef
                && $campaign->isLiveAt($now)) {
                return $campaign;
            }
        }

        return null;
    }

    public function usage(int $campaignId): array
    {
        return $this->usage[$campaignId] ?? ['claims' => 0, 'rewardTotal' => 0];
    }

    /** Simulate consumption (each claim adds one to claims and rewardAmount to rewardTotal). */
    public function consume(int $campaignId, int $amount): void
    {
        $current = $this->usage($campaignId);
        $this->usage[$campaignId] = [
            'claims' => $current['claims'] + 1,
            'rewardTotal' => $current['rewardTotal'] + $amount,
        ];
    }
}
