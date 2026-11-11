<?php

declare(strict_types=1);

namespace Shortform\Support;

final readonly class HttpRequest
{
    /** @param array<string,string> $headers */
    public function __construct(
        public string $method,
        public string $url,
        public array $headers = [],
        public ?string $body = null,
        public int $timeoutSeconds = 15,
        public int $connectTimeoutSeconds = 5,
    ) {
    }
}
