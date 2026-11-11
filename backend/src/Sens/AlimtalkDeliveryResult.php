<?php

declare(strict_types=1);

namespace Shortform\Sens;

/**
 * Per-message delivery result.
 * 3005 (AckTimeout) is neither success nor failure: the message may have arrived.
 * It is kept as "sent, unconfirmed" so operators can see it instead of a false failure.
 */
final readonly class AlimtalkDeliveryResult
{
    /** @param array<string,mixed> $raw */
    public function __construct(
        public string $requestId,
        public string $messageId,
        public string $requestStatusCode,
        public string $messageStatusCode,
        public string $messageStatusName,
        public string $messageStatusDesc,
        public bool $fallbackUsed,
        public array $raw,
    ) {
    }

    public function isDelivered(): bool
    {
        return $this->requestStatusCode === 'A000' && $this->messageStatusCode === '0000';
    }

    public function isUncertain(): bool
    {
        return $this->messageStatusCode === '3005';
    }

    /** @param array<string,mixed> $body */
    public static function fromResponse(array $body): self
    {
        return new self(
            (string) ($body['requestId'] ?? ''),
            (string) ($body['messageId'] ?? ''),
            (string) ($body['requestStatusCode'] ?? ''),
            (string) ($body['messageStatusCode'] ?? ''),
            (string) ($body['messageStatusName'] ?? ''),
            (string) ($body['messageStatusDesc'] ?? ''),
            isset($body['failover']),
            $body,
        );
    }
}
