<?php

declare(strict_types=1);

namespace Shortform\Tests\Support;

use Shortform\Support\Clock;

final class FixedClock implements Clock
{
    public function __construct(private readonly \DateTimeImmutable $at)
    {
    }

    public static function at(string $iso = '2026-11-11T09:00:00+09:00'): self
    {
        return new self(new \DateTimeImmutable($iso));
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
