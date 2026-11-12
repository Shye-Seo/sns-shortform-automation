<?php

declare(strict_types=1);

namespace Shortform\Domain\Interactive;

/**
 * One parsed interaction (comment/DM/mention) extracted from a platform webhook.
 *
 * `externalEventId` is the platform's own id for the comment. It is the dedupe key across
 * retries: Meta replays a webhook for up to 24 hours if it does not receive a 2xx, so the same
 * comment arrives several times by design.
 *
 * `authorRef` is already a HMAC of the platform user id. The raw id never leaves the edge — it is
 * a personal identifier and there is no product need to store it.
 */
final class WebhookComment
{
    public function __construct(
        public readonly string $externalEventId,
        public readonly string $platform,
        public readonly string $contentRef,
        public readonly string $authorRef,
        public readonly ?string $authorHandleRef,
        public readonly string $text,
        public readonly \DateTimeImmutable $receivedAt,
        public readonly ?string $clientIp = null,
        public readonly bool $isNewAccount = false,
    ) {
    }
}
