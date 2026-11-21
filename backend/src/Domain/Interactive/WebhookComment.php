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
        /**
         * 작성자가 이 계정의 팔로워인지. Meta 댓글 웹훅에는 이 값이 없으므로 보통 null이고,
         * 팔로워 목록을 동기화하는 쪽(운영 서버의 Graph API 동기화)이 실어 보낼 때만 값이 있다.
         */
        public readonly ?bool $authorFollowsAccount = null,
    ) {
    }
}
