<?php

declare(strict_types=1);

namespace Shortform\Tests\Support;

use Shortform\Support\Clock;

/**
 * A clock the test can move without sleeping.
 *
 * The 5 second SLA and the 15 minute token TTL are the two most important timings in this
 * pipeline; sleeping for either would make the suite unusable. The dispatcher takes a Clock for
 * exactly this reason.
 */
final class MutableClock implements Clock
{
    public function __construct(private \DateTimeImmutable $at)
    {
    }

    public static function at(string $iso = '2026-11-10T10:00:00+09:00'): self
    {
        return new self(new \DateTimeImmutable($iso));
    }

    public function set(string $iso): void
    {
        $this->at = new \DateTimeImmutable($iso);
    }

    public function advanceSeconds(float $seconds): void
    {
        $this->at = $this->at->modify('+' . (int) round($seconds * 1000) . ' milliseconds');
    }

    public function now(): \DateTimeImmutable
    {
        return $this->at;
    }

    public function epochMillisAsString(): string
    {
        return (string) ($this->at->getTimestamp() * 1000);
    }
}
