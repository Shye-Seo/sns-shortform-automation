<?php

declare(strict_types=1);

namespace Shortform\Domain\Interactive;

/**
 * Webhook handling result.
 *
 * Kept as a readonly class (rather than an array) because the controller, the worker and the
 * tests read the same fields; an array lets a typo go unnoticed until production.
 */
final class WebhookHandlingResult
{
    /**
     * @param array<string,int> $counts processed/accepted/enqueued/ignored/duplicate/abuse/rejected
     */
    public function __construct(
        public readonly bool $signatureValid,
        public readonly array $counts,
        public readonly string $reason = '',
    ) {
    }

    public function accepted(): int
    {
        return $this->counts['accepted'] ?? 0;
    }

    public function enqueued(): int
    {
        return $this->counts['enqueued'] ?? 0;
    }

    public function processed(): int
    {
        return $this->counts['processed'] ?? 0;
    }
}
