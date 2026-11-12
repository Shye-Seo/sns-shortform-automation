<?php

declare(strict_types=1);

namespace Shortform\Domain\Interactive;

/**
 * Result of clicking a deep link.
 *
 * Every rejection is a distinct outcome on purpose: the landing page says "이미 사용된 링크예요"
 * for ALREADY_CLAIMED and "기간이 지났어요" for EXPIRED. Collapsing them into one message
 * generates avoidable support tickets.
 */
final class ClaimResult
{
    public function __construct(
        public readonly string $outcome,
        public readonly string $reason = '',
        public readonly int $rewardAmount = 0,
    ) {
    }

    public static function granted(int $rewardAmount): self
    {
        return new self('GRANTED', '', $rewardAmount);
    }

    public static function rejected(string $outcome, string $reason): self
    {
        return new self($outcome, $reason);
    }

    public function isGranted(): bool
    {
        return $this->outcome === 'GRANTED';
    }
}
