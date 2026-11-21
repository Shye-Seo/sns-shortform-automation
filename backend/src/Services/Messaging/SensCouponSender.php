<?php

declare(strict_types=1);

namespace Shortform\Services\Messaging;

use Shortform\Repositories\NotificationSender;
use Shortform\Repositories\SendResult;
use Shortform\Sens\AlimtalkMessage;
use Shortform\Sens\SensException;
use Shortform\Services\NaverCloudSensService;

/**
 * SENS alimtalk transport for coupon drops.
 *
 * Alimtalk is template-based: the copy must be the reviewed template with variables
 * substituted, otherwise SENS answers 3016 (no matched template). The template code is
 * configuration (`SENS_TEMPLATE_COUPON`), not invented here, and the recipient must be a
 * phone number — a comment author only has one when the campaign collected it, which is why
 * the dispatcher chooses ALIMTALK for channels that do (YouTube entries with a phone form)
 * and INSTAGRAM_DM otherwise.
 *
 * 202 Accepted means "queued at SENS", not "delivered"; the attempt row keeps the request
 * id so a delivery lookup can reconcile later.
 */
final class SensCouponSender implements NotificationSender
{
    /** Reviewed alimtalk bodies are shorter than a DM; leave room for variables. */
    public const MAX_CONTENT_LENGTH = 900;

    public function __construct(
        private readonly NaverCloudSensService $sens,
        private readonly string $templateCode,
        private readonly string $plusFriendId,
        private readonly CouponMessageComposer $composer = new CouponMessageComposer(),
    ) {
        if ($templateCode === '') {
            throw new \InvalidArgumentException('SENS_TEMPLATE_COUPON is required for the alimtalk sender.');
        }
    }

    public function send(string $channel, string $recipientRef, array $payload): SendResult
    {
        if ($channel !== 'ALIMTALK') {
            return SendResult::permanentFailure("SENS sender cannot deliver channel {$channel}.", 0.0, 'sens');
        }

        try {
            $text = $this->composer->compose($payload, self::MAX_CONTENT_LENGTH);
            $message = new AlimtalkMessage(
                to: $recipientRef,
                content: $text,
                templateCode: $this->templateCode,
                plusFriendId: $this->plusFriendId,
            );
        } catch (\InvalidArgumentException $e) {
            return SendResult::permanentFailure('SENS message: ' . mb_substr($e->getMessage(), 0, 200), 0.0, 'sens');
        }

        $startedAt = microtime(true);
        try {
            $result = $this->sens->send($message);
        } catch (SensException $e) {
            $text = sprintf('SENS call failed (HTTP %d): %s', $e->httpStatus, $e->getMessage());

            return $e->isRetryable()
                ? SendResult::retryableFailure($text, (microtime(true) - $startedAt) * 1000, 'sens')
                : SendResult::permanentFailure($text, (microtime(true) - $startedAt) * 1000, 'sens');
        } catch (\Throwable $e) {
            return SendResult::retryableFailure(
                'SENS transport error: ' . mb_substr($e->getMessage(), 0, 200),
                (microtime(true) - $startedAt) * 1000,
                'sens',
            );
        }

        $latencyMs = (microtime(true) - $startedAt) * 1000;

        if ($result->isAccepted()) {
            return SendResult::delivered($result->requestId, $latencyMs, 'sens');
        }

        return SendResult::permanentFailure(
            sprintf('SENS rejected: %s %s', $result->statusCode, $result->statusName),
            $latencyMs,
            'sens',
        );
    }
}
