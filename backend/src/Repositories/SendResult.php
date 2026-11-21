<?php

declare(strict_types=1);

namespace Shortform\Repositories;

/**
 * Delivery result from a gateway.
 *
 * `messageId` is kept for reconciliation with the provider's delivery report (SENS gives
 * per-message status; Meta DMs give a message id). Without it, "sent" is only our belief.
 *
 * `provider` names the adapter that produced the result (`instagram`, `sens`, `dry_run`).
 * The dispatch_attempts ledger stores it, so an operator can tell a real delivery from a
 * dry run without guessing from the environment.
 */
final class SendResult
{
    public function __construct(
        public readonly bool $ok,
        public readonly bool $retryable = false,
        public readonly ?string $messageId = null,
        public readonly string $error = '',
        public readonly float $latencyMs = 0.0,
        public readonly string $provider = '',
    ) {
    }

    public static function delivered(string $messageId, float $latencyMs = 0.0, string $provider = ''): self
    {
        return new self(true, false, $messageId, '', $latencyMs, $provider);
    }

    public static function retryableFailure(string $error, float $latencyMs = 0.0, string $provider = ''): self
    {
        return new self(false, true, null, $error, $latencyMs, $provider);
    }

    public static function permanentFailure(string $error, float $latencyMs = 0.0, string $provider = ''): self
    {
        return new self(false, false, null, $error, $latencyMs, $provider);
    }

    public function outcome(): string
    {
        if ($this->ok) {
            return 'SENT';
        }

        return $this->retryable ? 'RETRYABLE_FAILURE' : 'PERMANENT_FAILURE';
    }
}
