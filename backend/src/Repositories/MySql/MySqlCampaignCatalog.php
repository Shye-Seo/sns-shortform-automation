<?php

declare(strict_types=1);

namespace Shortform\Repositories\MySql;

use Shortform\Database\Connection;
use Shortform\Domain\Interactive\InteractiveCampaign;
use Shortform\Repositories\CampaignCatalog;
use Shortform\Support\DbTime;

/**
 * Campaign lookup on interactive_campaigns.
 *
 * The webhook hot path is `findLiveByContent`: Meta sends a media id and nothing else about
 * the campaign, so the query is `(platform, content_ref)` plus the window, and it is served
 * by `idx_interactive_campaigns_content`. The window condition lives in SQL as well as in
 * `InteractiveCampaign::isLiveAt()` — the SQL version keeps an ended campaign from being
 * read at all, the PHP version keeps a fake/unit test honest.
 */
final class MySqlCampaignCatalog implements CampaignCatalog
{
    private const COLUMNS = 'id, tenant_id, code, platform, content_ref, trigger_keywords, reward_label,
        reward_amount, total_reward_budget, claim_limit, max_claims_per_user, token_ttl_minutes,
        starts_at, ends_at, status, follower_only, send_interval_seconds';

    public function __construct(private readonly Connection $connection)
    {
    }

    public function findById(int $campaignId): ?InteractiveCampaign
    {
        $stmt = $this->connection->pdo()->prepare(
            'SELECT ' . self::COLUMNS . ' FROM interactive_campaigns WHERE id = :id'
        );
        $stmt->execute(['id' => $campaignId]);
        $row = $stmt->fetch();

        return $row === false ? null : self::hydrate($row);
    }

    public function findLiveByContent(string $platform, string $contentRef, \DateTimeImmutable $now): ?InteractiveCampaign
    {
        $stmt = $this->connection->pdo()->prepare(
            'SELECT ' . self::COLUMNS . ' FROM interactive_campaigns
             WHERE platform = :platform
               AND content_ref = :content_ref
               AND status = :status
               AND starts_at <= :now
               AND ends_at > :now_end
             ORDER BY id DESC
             LIMIT 1'
        );
        $stmt->execute([
            'platform' => $platform,
            'content_ref' => $contentRef,
            'status' => 'live',
            'now' => DbTime::format($now),
            'now_end' => DbTime::format($now),
        ]);
        $row = $stmt->fetch();

        return $row === false ? null : self::hydrate($row);
    }

    /**
     * Claimed tokens are the source of truth for both counters: the budget is money that
     * actually left, not messages that were queued.
     *
     * @return array{claims:int, rewardTotal:int}
     */
    public function usage(int $campaignId): array
    {
        $stmt = $this->connection->pdo()->prepare(
            'SELECT COUNT(*) AS claims, COALESCE(SUM(reward_amount), 0) AS reward_total
             FROM instant_claim_tokens
             WHERE campaign_id = :campaign_id AND is_claimed = 1'
        );
        $stmt->execute(['campaign_id' => $campaignId]);
        $row = $stmt->fetch() ?: ['claims' => 0, 'reward_total' => 0];

        return [
            'claims' => (int) $row['claims'],
            'rewardTotal' => (int) $row['reward_total'],
        ];
    }

    /** @param array<string,mixed> $row */
    private static function hydrate(array $row): InteractiveCampaign
    {
        $keywords = $row['trigger_keywords'];
        if (is_string($keywords)) {
            $keywords = json_decode($keywords, true) ?: [];
        }

        return new InteractiveCampaign(
            id: (int) $row['id'],
            tenantId: (int) $row['tenant_id'],
            code: (string) $row['code'],
            platform: (string) $row['platform'],
            contentRef: (string) $row['content_ref'],
            triggerKeywords: array_values(array_map('strval', (array) $keywords)),
            rewardLabel: (string) $row['reward_label'],
            rewardAmount: (int) $row['reward_amount'],
            totalRewardBudget: (int) $row['total_reward_budget'],
            claimLimit: (int) $row['claim_limit'],
            maxClaimsPerUser: (int) $row['max_claims_per_user'],
            tokenTtlMinutes: (int) $row['token_ttl_minutes'],
            startsAt: DbTime::parse((string) $row['starts_at']) ?? new \DateTimeImmutable('now'),
            endsAt: DbTime::parse((string) $row['ends_at']) ?? new \DateTimeImmutable('now'),
            status: (string) $row['status'],
            followerOnly: (bool) ($row['follower_only'] ?? false),
            sendIntervalSeconds: (int) ($row['send_interval_seconds'] ?? 0),
        );
    }
}
