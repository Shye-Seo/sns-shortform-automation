<?php

declare(strict_types=1);

namespace Shortform\Services\Messaging;

/**
 * The DM / alimtalk body for a coupon drop.
 *
 * Kept in one place because the same text goes to two transports (Instagram DM and SENS
 * alimtalk) and a copy change must not make them diverge. It contains no name and no
 * account id — the recipient already knows who they are, and a leaked message log should
 * not add anything to the platform id the ledger deliberately hashes.
 *
 * Instagram caps a message at 1,000 characters; SENS reviewed templates are shorter. The
 * caller passes the limit and the composer truncates (a provider 400 for length is a
 * permanent failure, i.e. a coupon the user never receives).
 */
final class CouponMessageComposer
{
    /** @param array<string,mixed> $payload */
    public function compose(array $payload, int $limit = 1000): string
    {
        $reward = trim((string) ($payload['rewardLabel'] ?? ''));
        $deepLink = trim((string) ($payload['deepLink'] ?? ''));

        if ($deepLink === '') {
            throw new \InvalidArgumentException('A coupon message needs a deepLink.');
        }
        if ($reward === '') {
            $reward = '쿠폰';
        }

        $text = implode("\n", [
            '댓글 남겨주셔서 고마워요.',
            "{$reward} 쿠폰이에요.",
            $deepLink,
            '이 링크는 15분 동안 1번만 쓸 수 있어요.',
        ]);

        return mb_substr($text, 0, $limit);
    }
}
