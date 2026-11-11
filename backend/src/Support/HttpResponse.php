<?php

declare(strict_types=1);

namespace Shortform\Support;

final readonly class HttpResponse
{
    /** @param array<string,string> $headers lower-cased keys */
    public function __construct(
        public int $status,
        public string $body,
        public array $headers = [],
        public string $url = '',
    ) {
    }

    public function isSuccess(): bool
    {
        return $this->status >= 200 && $this->status < 300;
    }

    public function header(string $name): ?string
    {
        return $this->headers[strtolower($name)] ?? null;
    }

    /** @return array<string,mixed> */
    public function json(): array
    {
        $decoded = json_decode($this->body, true);
        if (!is_array($decoded)) {
            throw new \RuntimeException('Response is not JSON: ' . mb_substr($this->body, 0, 200));
        }

        return $decoded;
    }
}
