<?php

declare(strict_types=1);

namespace Shortform\Http;

class BadRequestException extends \RuntimeException
{
    /** @param array<string,mixed> $details */
    public function __construct(string $message, private readonly array $details = [])
    {
        parent::__construct($message);
    }

    /** @return array<string,mixed> */
    public function details(): array
    {
        return $this->details;
    }
}
