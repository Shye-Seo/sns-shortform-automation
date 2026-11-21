<?php

declare(strict_types=1);

namespace Shortform\Services\Messaging;

use Shortform\Repositories\NotificationSender;
use Shortform\Repositories\SendResult;
use Shortform\Services\InstagramConfig;
use Shortform\Support\HttpClient;
use Shortform\Support\HttpRequest;

/**
 * Instagram Messaging API — private reply to a comment.
 *
 * Why `comment_id` and not the user id: Instagram's private-reply endpoint
 * (`POST /{ig-user-id}/messages` with `recipient.comment_id`) is the supported way to turn a
 * public comment into a DM, and it is not subject to the 24 hour messaging window that a
 * plain `recipient.id` send hits. The dispatcher puts the comment id in the payload; the raw
 * author id is only used as a fallback when a campaign targets a known IGSID (alimtalk-style
 * flows on other channels).
 *
 * Error classification is the other half of the integration. A 429 or a `code 4` (application
 * rate limit) is worth retrying inside the 5 second SLA; `code 190` (expired token) and
 * `code 100` (bad recipient) are not — retrying them burns quota and ends in the same place.
 * The `retryable` flag is the gateway's judgement, per the NotificationSender contract.
 */
final class InstagramMessagingSender implements NotificationSender
{
    public const MAX_TEXT_LENGTH = 1000;

    /** Meta error codes that mean "slow down", not "fix your request". */
    private const RETRYABLE_CODES = [4, 17, 32, 613];

    public function __construct(
        private readonly HttpClient $http,
        private readonly InstagramConfig $config,
        private readonly CouponMessageComposer $composer = new CouponMessageComposer(),
    ) {
    }

    public function send(string $channel, string $recipientRef, array $payload): SendResult
    {
        if ($channel !== 'INSTAGRAM_DM') {
            return SendResult::permanentFailure("Instagram sender cannot deliver channel {$channel}.", 0.0, 'instagram');
        }

        $commentId = trim((string) ($payload['commentId'] ?? ''));
        if ($commentId !== '') {
            $recipient = ['comment_id' => $commentId];
        } elseif ($recipientRef !== '') {
            $recipient = ['id' => $recipientRef];
        } else {
            return SendResult::permanentFailure('Instagram DM has no recipient (comment_id or user id).', 0.0, 'instagram');
        }

        try {
            $text = $this->composer->compose($payload, self::MAX_TEXT_LENGTH);
        } catch (\InvalidArgumentException $e) {
            return SendResult::permanentFailure('Instagram DM body: ' . $e->getMessage(), 0.0, 'instagram');
        }

        $startedAt = microtime(true);
        try {
            $response = $this->http->send(new HttpRequest(
                method: 'POST',
                url: sprintf(
                    '%s/%s/messages',
                    $this->config->graphBase(),
                    $this->config->igUserId,
                ),
                headers: [
                    'Authorization' => 'Bearer ' . $this->config->accessToken,
                    'Content-Type' => 'application/json',
                ],
                body: json_encode([
                    'recipient' => $recipient,
                    'message' => ['text' => $text],
                ], JSON_UNESCAPED_UNICODE),
                timeoutSeconds: 10,
            ));
        } catch (\Throwable $e) {
            // Network failure/timeout: the request may or may not have reached Meta, but the
            // attempt ledger records it and the queue decides retry vs DLQ.
            return SendResult::retryableFailure(
                'Instagram DM transport error: ' . mb_substr($e->getMessage(), 0, 200),
                (microtime(true) - $startedAt) * 1000,
                'instagram',
            );
        }

        $latencyMs = (microtime(true) - $startedAt) * 1000;
        $body = json_decode($response->body, true);
        $body = is_array($body) ? $body : [];

        if ($response->isSuccess()) {
            $messageId = (string) ($body['message_id'] ?? '');

            return SendResult::delivered($messageId, $latencyMs, 'instagram');
        }

        return $this->classifyFailure($response->status, $body, $latencyMs);
    }

    /** @param array<string,mixed> $body */
    private function classifyFailure(int $status, array $body, float $latencyMs): SendResult
    {
        $error = is_array($body['error'] ?? null) ? $body['error'] : [];
        $code = (int) ($error['code'] ?? 0);
        $message = trim((string) ($error['message'] ?? ''));
        if ($message === '') {
            $message = 'HTTP ' . $status;
        }

        $retryable = $status === 429
            || $status >= 500
            || in_array($code, self::RETRYABLE_CODES, true);

        $text = sprintf('Instagram DM failed (HTTP %d, code %d): %s', $status, $code, mb_substr($message, 0, 180));

        return $retryable
            ? SendResult::retryableFailure($text, $latencyMs, 'instagram')
            : SendResult::permanentFailure($text, $latencyMs, 'instagram');
    }
}
