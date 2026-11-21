<?php

declare(strict_types=1);

namespace Shortform\Controllers;

use Shortform\Http\BadRequestException;
use Shortform\Http\Request;
use Shortform\Security\MetaWebhookSignatureVerifier;

/**
 * One endpoint, two event types.
 *
 * Meta sends both publishing notifications (`field: media`) and comments (`field: comments`)
 * to the same callback URL. They are handled by different pipelines:
 *
 *   media    → publish_logs state machine (this project's first half)
 *   comments → comment → coupon dispatcher (this project's second half)
 *
 * The signature is checked once, over the raw body, before either path sees the payload.
 * A body that fails is rejected with 403 and nothing is persisted — including the comment
 * rows, whose author ids would otherwise land in the ledger from an unauthenticated caller.
 *
 * The response keeps the media counts at the top level (existing operators and dashboards
 * read `applied`/`duplicates`) and adds `comments` beside them.
 */
final class InstagramWebhookController
{
    public function __construct(
        private readonly PublishWebhookController $publishing,
        private readonly CommentsWebhookController $comments,
        private readonly MetaWebhookSignatureVerifier $signatures,
    ) {
    }

    /** GET: Meta's verification handshake — echo the challenge verbatim. */
    public function verify(Request $request): string
    {
        return $this->publishing->verify($request);
    }

    /**
     * @return array<string,mixed>
     */
    public function receive(Request $request): array
    {
        $this->signatures->assertValid($request->rawBody, $request->header(MetaWebhookSignatureVerifier::HEADER));

        $payload = json_decode($request->rawBody, true);
        if (! is_array($payload)) {
            throw new BadRequestException('Webhook body is not JSON.');
        }

        if (($payload['object'] ?? '') !== 'instagram') {
            return [
                'received' => 0,
                'applied' => 0,
                'duplicates' => 0,
                'unknown_media' => 0,
                'ignored' => 1,
                'comments' => [
                    'processed' => 0, 'accepted' => 0, 'enqueued' => 0, 'ignored' => 0,
                    'duplicate' => 0, 'abuse' => 0, 'rejected' => 0, 'status' => 'NOT_INSTAGRAM',
                ],
            ];
        }

        $media = $this->publishing->apply($payload);
        $comments = $this->comments->apply($payload, $request->clientIp);

        return $media + ['comments' => $comments];
    }

    /**
     * Kept for callers that only need a boolean (health checks, tests, CLI replay).
     */
    public function isSignatureValid(string $rawBody, ?string $header): bool
    {
        return $this->signatures->verify($rawBody, $header);
    }
}
