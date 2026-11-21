<?php

declare(strict_types=1);

namespace Shortform\Controllers;

use Shortform\Services\InteractiveCouponDispatcher;

/**
 * Comment half of the Instagram webhook.
 *
 * The signature is verified by the caller (`InstagramWebhookController`) because both halves
 * share one HTTP body. This class only says: this payload has already been authenticated, so
 * hand it to the dispatcher and report what happened per comment.
 *
 * A non-zero `enqueued` here means a DM was scheduled within the 5 second deadline; the
 * actual send happens in `bin/coupon-worker.php`. Reporting the two separately is what lets
 * Meta's retry stop (200) while the user still receives a coupon a moment later.
 */
final class CommentsWebhookController
{
    public function __construct(private readonly InteractiveCouponDispatcher $dispatcher)
    {
    }

    /**
     * @param array<string,mixed> $payload
     * @return array{processed:int, accepted:int, enqueued:int, ignored:int, duplicate:int, abuse:int, rejected:int, status:string}
     */
    public function apply(array $payload, ?string $clientIp = null): array
    {
        $result = $this->dispatcher->handleWebhook($payload, true, $clientIp);

        return [
            'processed' => $result->counts['processed'] ?? 0,
            'accepted' => $result->counts['accepted'] ?? 0,
            'enqueued' => $result->counts['enqueued'] ?? 0,
            'ignored' => $result->counts['ignored'] ?? 0,
            'duplicate' => $result->counts['duplicate'] ?? 0,
            'abuse' => $result->counts['abuse'] ?? 0,
            'rejected' => $result->counts['rejected'] ?? 0,
            'status' => $result->reason !== '' ? $result->reason : 'OK',
        ];
    }
}
