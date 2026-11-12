<?php

declare(strict_types=1);

namespace Shortform\Repositories;

/**
 * Delivery result from a gateway.
 *
 * `messageId` is kept for reconciliation with the provider's delivery report (SENS gives
 * per-message status; Meta DMs give a message id). Without it, "sent" is only our belief.
 */
final class SendResult
{
    public function __construct(
        public readonly bool $ok,
        public readonly bool $retryable = false,
        public readonly ?string $messageId = null,
        public readonly string $error = '',
        public readonly float $latencyMs = 0.0,
    ) {
    }

    public static function delivered(string $messageId, float $latencyMs = 0.0): self
    {
        return new self(true, false, $messageId, '', $latencyMs);
    }

    public static function retryableFailure(string $error, float $latencyMs = 0.0): self
    {
        return new self(false, true, null, $error, $latencyMs);
    }

    public static function permanentFailure(string $error, float $latencyMs = 0.0): self
    {
        return new self(false, false, null, $error, $latencyMs);
    }
}
