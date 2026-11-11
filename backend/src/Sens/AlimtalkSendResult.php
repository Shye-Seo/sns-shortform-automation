<?php

declare(strict_types=1);

namespace Shortform\Sens;

/**
 * 202 Accepted means "queued at SENS", not "delivered".
 * Delivery is confirmed separately by messageStatusCode 0000 on the result lookup.
 */
final readonly class AlimtalkSendResult
{
    /** @param array<string,mixed> $raw */
    public function __construct(
        public string $requestId,
        public string $requestTime,
        public string $statusCode,
        public string $statusName,
        public array $raw,
    ) {
    }

    public function isAccepted(): bool
    {
        return $this->statusCode === '202' || strtolower($this->statusName) === 'accepted';
    }

    /** @param array<string,mixed> $body */
    public static function fromResponse(array $body): self
    {
        return new self(
            (string) ($body['requestId'] ?? ''),
            (string) ($body['requestTime'] ?? ''),
            (string) ($body['statusCode'] ?? ''),
            (string) ($body['statusName'] ?? ''),
            $body,
        );
    }
}
