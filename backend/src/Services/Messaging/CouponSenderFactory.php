<?php

declare(strict_types=1);

namespace Shortform\Services\Messaging;

use Shortform\Repositories\NotificationSender;
use Shortform\Sens\SensConfig;
use Shortform\Services\InstagramConfig;
use Shortform\Services\NaverCloudSensService;
use Shortform\Support\Clock;
use Shortform\Support\Env;
use Shortform\Support\HttpClient;

/**
 * Which transport actually sends a coupon.
 *
 *   COUPON_SENDER=dryrun  (default) every send is recorded, nothing leaves the machine
 *   COUPON_SENDER=live    Meta and/or SENS, and a channel without credentials fails loudly
 *   COUPON_SENDER=auto    real where configured; dry-run only when nothing is configured
 *
 * The default must be dry-run: a checkout that "works" locally but charges or DMs a real
 * person because an env var was missing is exactly the failure this switch prevents.
 */
final class CouponSenderFactory
{
    public static function fromEnv(HttpClient $http, Clock $clock): NotificationSender
    {
        $mode = strtolower(Env::get('COUPON_SENDER', 'dryrun') ?? 'dryrun');

        $igUserId = Env::get('IG_BUSINESS_ACCOUNT_ID', '') ?? '';
        $igToken = Env::get('IG_ACCESS_TOKEN', '') ?? '';
        $igConfigured = $igUserId !== '' && $igToken !== '';

        $sensConfigured = Env::get('SENS_ACCESS_KEY') !== null
            && Env::get('SENS_SECRET_KEY') !== null
            && Env::get('SENS_SERVICE_ID') !== null;

        return match ($mode) {
            'dryrun' => new DryRunNotificationSender(),
            'live' => self::live($http, $clock, $igConfigured, $igUserId, $igToken, $sensConfigured),
            'auto' => ($igConfigured || $sensConfigured)
                ? self::live($http, $clock, $igConfigured, $igUserId, $igToken, $sensConfigured)
                : new DryRunNotificationSender(),
            default => throw new \InvalidArgumentException("Unknown COUPON_SENDER mode: {$mode}"),
        };
    }

    private static function live(
        HttpClient $http,
        Clock $clock,
        bool $igConfigured,
        string $igUserId,
        string $igToken,
        bool $sensConfigured,
    ): NotificationSender {
        if (! $igConfigured && ! $sensConfigured) {
            throw new \RuntimeException(
                'COUPON_SENDER=live requires IG_BUSINESS_ACCOUNT_ID + IG_ACCESS_TOKEN or SENS credentials.'
            );
        }

        $senders = [];

        $senders['INSTAGRAM_DM'] = $igConfigured
            ? new InstagramMessagingSender($http, new InstagramConfig(
                igUserId: $igUserId,
                accessToken: $igToken,
                apiVersion: Env::get('IG_GRAPH_VERSION', 'v21.0') ?? 'v21.0',
            ))
            : new UnconfiguredNotificationSender('IG_BUSINESS_ACCOUNT_ID / IG_ACCESS_TOKEN are missing.');

        $senders['ALIMTALK'] = $sensConfigured
            ? new SensCouponSender(
                new NaverCloudSensService($http, new SensConfig(
                    accessKey: Env::required('SENS_ACCESS_KEY'),
                    secretKey: Env::required('SENS_SECRET_KEY'),
                    serviceId: Env::required('SENS_SERVICE_ID'),
                    plusFriendId: Env::get('SENS_PLUS_FRIEND_ID', '@shortform') ?? '@shortform',
                    templateCodes: SensConfig::defaultTemplateCodes(),
                    failoverFrom: Env::get('SENS_FAILOVER_FROM'),
                    baseUrl: Env::get('SENS_BASE_URL', 'https://sens.apigw.ntruss.com') ?? 'https://sens.apigw.ntruss.com',
                ), $clock),
                templateCode: Env::get('SENS_TEMPLATE_COUPON', 'COUPON_CLAIM_V1') ?? 'COUPON_CLAIM_V1',
                plusFriendId: Env::get('SENS_PLUS_FRIEND_ID', '@shortform') ?? '@shortform',
            )
            : new UnconfiguredNotificationSender('SENS_ACCESS_KEY / SENS_SECRET_KEY / SENS_SERVICE_ID are missing.');

        return new RoutingNotificationSender($senders);
    }
}
