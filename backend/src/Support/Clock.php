<?php

declare(strict_types=1);

namespace Shortform\Support;

/**
 * Time is injected everywhere.
 * NCP request signatures embed a millisecond timestamp; GitHub-style HMAC webhooks and
 * the Graph API container poller both need deterministic "now" to be testable.
 */
interface Clock
{
    public function now(): \DateTimeImmutable;

    /** Unix epoch in milliseconds, as a string (x-ncp-apigw-timestamp). */
    public function epochMillisAsString(): string;
}
