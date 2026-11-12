<?php

declare(strict_types=1);

namespace Shortform\Services;

use Shortform\Domain\Interactive\FraudVerdict;
use Shortform\Domain\Interactive\InteractiveCampaign;
use Shortform\Domain\Interactive\WebhookComment;
use Shortform\Repositories\InteractionEventStore;

/**
 * Macro / multi-account detection for comment-to-coupon campaigns.
 *
 * Why a separate service: the coupon campaign in the sibling project scores *entry* traffic
 * (device fingerprint, phone hash, UTM). Here the only identity Instagram/YouTube gives us is a
 * hashed author id, plus the text and (sometimes) an IP from our own link shortener. The signals
 * are therefore different and deserve their own weights and tests.
 *
 * The window is 10 seconds. That is not arbitrary: a legitimate user comments once and waits; a
 * script fires dozens of comments within the same second. A 10 second window catches the burst
 * without counting a genuinely popular video's organic comments as abuse.
 *
 * The scorer never blocks on a single weak signal. Blocking a family who shared a phone would
 * create a support incident and a public complaint; the cost of one extra coupon is 3,000 won.
 */
final class FraudDetectionService
{
    private const WINDOW_SECONDS = 10;

    public const AUTHOR_BURST = 'AUTHOR_BURST';
    public const SUBNET_FLOOD = 'SUBNET_FLOOD';
    public const NEW_ACCOUNT = 'NEW_ACCOUNT';
    public const SPAM_TEXT = 'SPAM_TEXT';
    public const RATE_LIMIT = 'RATE_LIMIT';

    public function __construct(private readonly InteractionEventStore $events)
    {
    }

    public function assess(WebhookComment $comment, ?string $clientIp = null, bool $rateLimited = false): FraudVerdict
    {
        $since = $comment->receivedAt->modify('-' . self::WINDOW_SECONDS . ' seconds');
        $score = 0;
        $reasons = [];

        // 같은 작성자가 10초에 3건 이상 — 사람이 손으로 하기 어려운 속도
        if ($this->events->countFromAuthor($comment->authorRef, $since) >= 3) {
            $score += 40;
            $reasons[] = self::AUTHOR_BURST;
        }

        $subnet = self::subnetOf($clientIp);
        if ($subnet !== null && $this->events->countFromSubnet($subnet, $since) >= 20) {
            $score += 30;
            $reasons[] = self::SUBNET_FLOOD;
        }

        if ($comment->isNewAccount) {
            $score += 20;
            $reasons[] = self::NEW_ACCOUNT;
        }

        $normalised = InteractiveCampaign::normalise($comment->text);
        $tooShort = mb_strlen($normalised) < 3;
        $repeated = $normalised !== '' && $this->events->countSameBody($normalised, $since) >= 5;
        if ($tooShort || $repeated) {
            $score += 15;
            $reasons[] = self::SPAM_TEXT;
        }

        if ($rateLimited) {
            $score += 35;
            $reasons[] = self::RATE_LIMIT;
        }

        return new FraudVerdict(min(100, $score), $reasons);
    }

    /** /24 for IPv4 (macro farms rotate the host part), /64 prefix for IPv6. */
    public static function subnetOf(?string $ip): ?string
    {
        if ($ip === null || $ip === '') {
            return null;
        }

        if (filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_IPV4)) {
            $parts = explode('.', $ip);

            return implode('.', array_slice($parts, 0, 3)) . '.0/24';
        }

        if (filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_IPV6)) {
            $packed = inet_pton($ip);
            if ($packed === false) {
                return null;
            }

            return bin2hex(substr($packed, 0, 8)) . '::/64';
        }

        return null;
    }

    /** Human-readable Korean sentence for the operator console. */
    public function describe(FraudVerdict $verdict): string
    {
        $labels = [
            self::AUTHOR_BURST => '같은 계정이 10초에 3건 이상 댓글',
            self::SUBNET_FLOOD => '같은 서브넷에서 10초에 20건 이상',
            self::NEW_ACCOUNT => '가입 24시간 이내 계정',
            self::SPAM_TEXT => '본문이 3자 미만이거나 동일 문구 반복',
            self::RATE_LIMIT => '레이트 리밋 초과',
        ];

        if ($verdict->reasons === []) {
            return '특이 신호 없음';
        }

        return implode(' · ', array_map(static fn (string $r): string => $labels[$r] ?? $r, $verdict->reasons));
    }
}
