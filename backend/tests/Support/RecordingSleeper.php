<?php

declare(strict_types=1);

namespace Shortform\Tests\Support;

use Shortform\Support\Sleeper;

/** Records requested delays instead of waiting, so backoff is asserted, not felt. */
final class RecordingSleeper implements Sleeper
{
    /** @var list<int> */
    public array $delays = [];

    public function sleepMilliseconds(int $milliseconds): void
    {
        $this->delays[] = $milliseconds;
    }
}
