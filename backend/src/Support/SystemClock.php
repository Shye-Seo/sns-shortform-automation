<?php

declare(strict_types=1);

namespace Shortform\Support;

final class SystemClock implements Clock
{
    public function __construct(private readonly string $timezone = 'Asia/Seoul')
    {
    }

    public function now(): \DateTimeImmutable
    {
        return new \DateTimeImmutable('now', new \DateTimeZone($this->timezone));
    }

    public function epochMillisAsString(): string
    {
        return (string) (int) floor(microtime(true) * 1000);
    }
}
