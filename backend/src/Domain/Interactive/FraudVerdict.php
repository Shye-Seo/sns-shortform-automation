<?php

declare(strict_types=1);

namespace Shortform\Domain\Interactive;

/**
 * Fraud assessment for one comment.
 *
 * The score is additive over independent signals, capped at 100. A single signal is rarely
 * enough to block (a family sharing a device is not a macro farm), but three overlapping signals
 * almost always are. Weights live here — not in SQL — so the rule can be tested deterministically
 * and changed with a code review.
 *
 *   AUTHOR_BURST   +40  same author commented 3+ times in 10s
 *   SUBNET_FLOOD   +30  same /24 subnet produced 20+ comments in 10s
 *   NEW_ACCOUNT    +20  account created within 24h
 *   SPAM_TEXT      +15  body under 3 chars, or the same body 5+ times in 10s
 *   RATE_LIMIT     +35  caller-level token bucket exhausted
 *
 * 50+ is blocked; the same threshold is recorded as `is_abusing` in the event row.
 */
final class FraudVerdict
{
    public const BLOCK_THRESHOLD = 50;

    /**
     * @param list<string> $reasons
     */
    public function __construct(
        public readonly int $score,
        public readonly array $reasons,
    ) {
    }

    public static function clean(): self
    {
        return new self(0, []);
    }

    public function isBlocked(): bool
    {
        return $this->score >= self::BLOCK_THRESHOLD;
    }

    public function summary(): string
    {
        return $this->reasons === [] ? 'no signals' : implode(',', $this->reasons);
    }
}
