<?php

declare(strict_types=1);

namespace Shortform\Domain\Interactive;

/**
 * An interactive campaign tied to a specific shortform post.
 *
 * The campaign is the policy object: which keywords count as an entry, how much reward one
 * person can get, how many total, and how long a claim link stays valid. The dispatcher reads it
 * and never invents defaults — a missing campaign means "not our post", not "use some rule".
 *
 * Window semantics are `[startsAt, endsAt)`. A comment received exactly at `endsAt` is too late;
 * that keeps the rule identical to the coupon campaign in the sibling project and makes boundary
 * tests unambiguous.
 */
final class InteractiveCampaign
{
    /**
     * @param list<string> $triggerKeywords
     */
    public function __construct(
        public readonly int $id,
        public readonly int $tenantId,
        public readonly string $code,
        public readonly string $platform,
        public readonly string $contentRef,
        public readonly array $triggerKeywords,
        public readonly string $rewardLabel,
        public readonly int $rewardAmount,
        public readonly int $totalRewardBudget,
        public readonly int $claimLimit,
        public readonly int $maxClaimsPerUser,
        public readonly int $tokenTtlMinutes,
        public readonly \DateTimeImmutable $startsAt,
        public readonly \DateTimeImmutable $endsAt,
        public readonly string $status,
    ) {
    }

    public function isLiveAt(\DateTimeImmutable $now): bool
    {
        return $this->status === 'live' && $now >= $this->startsAt && $now < $this->endsAt;
    }

    /**
     * Keyword match.
     *
     * Normalisation matters in Korean: people write "할 인", "할인!!", "쿠폰주세요". We strip
     * whitespace, punctuation and zero-width characters, then do a plain substring test. A regex
     * with word boundaries fails on Korean because there are no spaces between particles
     * ("할인받고싶어요").
     *
     * @return string|null the matched keyword, or null when nothing matches
     */
    public function matchKeyword(string $text): ?string
    {
        $normalised = self::normalise($text);
        if ($normalised === '') {
            return null;
        }

        foreach ($this->triggerKeywords as $keyword) {
            $needle = self::normalise($keyword);
            if ($needle !== '' && str_contains($normalised, $needle)) {
                return $keyword;
            }
        }

        return null;
    }

    /** Lowercase, remove whitespace/punctuation/symbols. Keeps Hangul and alphanumerics. */
    public static function normalise(string $text): string
    {
        $lower = mb_strtolower($text, 'UTF-8');
        // \p{L} letters, \p{N} numbers — everything else (spaces, emoji, punctuation) is dropped.
        $stripped = preg_replace('/[^\p{L}\p{N}]+/u', '', $lower);

        return $stripped ?? '';
    }
}
