<?php

declare(strict_types=1);

namespace Shortform\Http;

/** Webhook signature/verification failure. Maps to 403 so the platform retries nothing. */
final class WebhookRejected extends \RuntimeException
{
    public function __construct(string $message)
    {
        parent::__construct($message);
    }
}
