<?php

declare(strict_types=1);

namespace Shortform\Controllers;

use Shortform\Http\BadRequestException;
use Shortform\Http\Request;
use Shortform\Http\WebhookRejected;
use Shortform\Repositories\PublishStore;
use Shortform\Repositories\WebhookApplyResult;
use Shortform\Support\Clock;

/**
 * Meta (Instagram) webhook endpoint.
 *
 * Two different requests arrive on the same URL and both are easy to get wrong:
 *
 *   GET  /webhooks/instagram?hub.mode=subscribe&hub.verify_token=…&hub.challenge=…
 *        → answer with the raw challenge string, nothing else (not JSON).
 *        Note: PHP rewrites dots in query keys to underscores (`hub_mode`), so the
 *        verification code has to look for both spellings. This single detail is the most
 *        common reason a Meta webhook "cannot be verified".
 *
 *   POST /webhooks/instagram   with X-Hub-Signature-256: sha256=<hmac>
 *        → verify HMAC-SHA256 over the **raw body** with the app secret, then apply.
 *        Parsing JSON before verifying (or using the re-encoded array) changes the bytes
 *        and the signature never matches.
 *
 * Delivery is at-least-once (Meta retries for 24h). The store deduplicates by event id, so
 * a redelivery is counted as a duplicate instead of double-counting metrics.
 */
final class PublishWebhookController
{
    public function __construct(
        private readonly PublishStore $store,
        private readonly string $verifyToken,
        private readonly string $appSecret,
        private readonly Clock $clock,
    ) {
    }

    /** Returns the challenge string that must be echoed verbatim. */
    public function verify(Request $request): string
    {
        $mode = $request->queryString('hub_mode') ?? $request->queryString('hub.mode');
        $token = $request->queryString('hub_verify_token') ?? $request->queryString('hub.verify_token');
        $challenge = $request->queryString('hub_challenge') ?? $request->queryString('hub.challenge');

        if ($mode !== 'subscribe') {
            throw new BadRequestException('hub.mode must be "subscribe".');
        }
        if ($token === null || !hash_equals($this->verifyToken, $token)) {
            throw new WebhookRejected('hub.verify_token does not match IG_VERIFY_TOKEN.');
        }
        if ($challenge === null) {
            throw new BadRequestException('hub.challenge is missing.');
        }

        return $challenge;
    }

    /**
     * @return array{received:int, applied:int, duplicates:int, unknown_media:int, ignored:int}
     */
    public function receive(Request $request): array
    {
        $signature = $request->header('x-hub-signature-256');
        if (!$this->isSignatureValid($request->rawBody, $signature)) {
            throw new WebhookRejected('X-Hub-Signature-256 mismatch: check IG_APP_SECRET and that the raw body was used.');
        }

        $payload = json_decode($request->rawBody, true);
        if (!is_array($payload)) {
            throw new BadRequestException('Webhook body is not JSON.');
        }
        if (($payload['object'] ?? '') !== 'instagram') {
            // Other object types can be subscribed to the same app; ignore them, do not fail.
            return ['received' => 0, 'applied' => 0, 'duplicates' => 0, 'unknown_media' => 0, 'ignored' => 1];
        }

        $received = 0;
        $applied = 0;
        $duplicates = 0;
        $unknown = 0;
        $ignored = 0;
        $now = $this->clock->now();

        foreach ((array) ($payload['entry'] ?? []) as $entry) {
            $entryId = (string) ($entry['id'] ?? '');
            $entryTime = (string) ($entry['time'] ?? '');

            foreach ((array) ($entry['changes'] ?? []) as $change) {
                if (($change['field'] ?? '') !== 'media') {
                    $ignored++;
                    continue;
                }

                $value = (array) ($change['value'] ?? []);
                $mediaId = (string) ($value['media_id'] ?? '');
                if ($mediaId === '') {
                    $ignored++;
                    continue;
                }

                $received++;
                // Meta's media webhook does not always carry a status field; when it is
                // absent the event is the publish confirmation for a subscribed media id.
                $status = (string) ($value['status'] ?? 'published');
                $status = match ($status) {
                    'published', 'PUBLISHED' => 'published',
                    'failed', 'ERROR' => 'failed',
                    'expired', 'EXPIRED' => 'expired',
                    default => 'published',
                };

                // Event id must be stable across redeliveries but unique per event.
                $eventId = implode(':', [$entryId, $mediaId, $entryTime, $status]);

                match ($this->store->applyWebhookEvent($mediaId, $eventId, $status, $value, $now)) {
                    WebhookApplyResult::Applied => $applied++,
                    WebhookApplyResult::Duplicate => $duplicates++,
                    WebhookApplyResult::Unknown => $unknown++,
                };
            }
        }

        return [
            'received' => $received,
            'applied' => $applied,
            'duplicates' => $duplicates,
            'unknown_media' => $unknown,
            'ignored' => $ignored,
        ];
    }

    public function isSignatureValid(string $rawBody, ?string $header): bool
    {
        if ($header === null || $this->appSecret === '') {
            return false;
        }
        $expected = 'sha256=' . hash_hmac('sha256', $rawBody, $this->appSecret);

        return hash_equals($expected, trim($header));
    }
}
