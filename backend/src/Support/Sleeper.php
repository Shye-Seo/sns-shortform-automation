<?php

declare(strict_types=1);

namespace Shortform\Support;

/** Sleep abstraction so poller backoff is testable without wall-clock waiting. */
interface Sleeper
{
    public function sleepMilliseconds(int $milliseconds): void;
}
