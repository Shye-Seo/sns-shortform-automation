<?php

declare(strict_types=1);

namespace Shortform\Bootstrap;

use Shortform\Controllers\CommentsWebhookController;
use Shortform\Controllers\InstagramWebhookController;
use Shortform\Controllers\PublishWebhookController;
use Shortform\Database\Connection;
use Shortform\Repositories\MySql\MySqlCampaignCatalog;
use Shortform\Repositories\MySql\MySqlClaimTokenStore;
use Shortform\Repositories\MySql\MySqlDispatchAttemptStore;
use Shortform\Repositories\MySql\MySqlDispatchQueueStore;
use Shortform\Repositories\MySql\MySqlInteractionEventStore;
use Shortform\Repositories\ShortformRepository;
use Shortform\Security\HmacTokenSigner;
use Shortform\Security\MetaWebhookSignatureVerifier;
use Shortform\Security\Pseudonymizer;
use Shortform\Services\FraudDetectionService;
use Shortform\Services\InteractiveCouponDispatcher;
use Shortform\Services\Messaging\CouponSenderFactory;
use Shortform\Support\Clock;
use Shortform\Support\Env;
use Shortform\Support\HttpClient;

/**
 * Composition root for the comment → coupon half.
 *
 * Both the HTTP entry point and the worker build the same object graph from here. Keeping it
 * in one place is what makes "the route and the worker use the same store" true by
 * construction instead of by review: if the HTTP path enqueued with one implementation and
 * the worker claimed with another, the queue would look empty forever.
 */
final class CouponServices
{
    public readonly MySqlCampaignCatalog $campaigns;

    public readonly MySqlInteractionEventStore $events;

    public readonly MySqlDispatchQueueStore $queue;

    public readonly MySqlClaimTokenStore $tokens;

    public readonly MySqlDispatchAttemptStore $attempts;

    public readonly InteractiveCouponDispatcher $dispatcher;

    private function __construct(Connection $connection, Clock $clock, HttpClient $http)
    {
        $this->campaigns = new MySqlCampaignCatalog($connection);
        $this->events = new MySqlInteractionEventStore($connection, new Pseudonymizer(self::pseudonymKey()));
        $this->queue = new MySqlDispatchQueueStore($connection);
        $this->tokens = new MySqlClaimTokenStore($connection);
        $this->attempts = new MySqlDispatchAttemptStore($connection);

        $this->dispatcher = new InteractiveCouponDispatcher(
            campaigns: $this->campaigns,
            events: $this->events,
            queue: $this->queue,
            tokens: $this->tokens,
            sender: CouponSenderFactory::fromEnv($http, $clock),
            signer: new HmacTokenSigner(...self::signingKeys()),
            fraud: new FraudDetectionService($this->events),
            clock: $clock,
            slaSeconds: Env::int('COUPON_SLA_SECONDS', 5),
            maxAttempts: Env::int('COUPON_MAX_ATTEMPTS', 5),
            deepLinkBase: Env::get('COUPON_DEEP_LINK_BASE', 'https://coupon.shye.kr/c') ?? 'https://coupon.shye.kr/c',
            attempts: $this->attempts,
        );
    }

    public static function fromEnv(Connection $connection, Clock $clock, HttpClient $http): self
    {
        return new self($connection, $clock, $http);
    }

    /**
     * The webhook controller that owns GET/POST /webhooks/instagram.
     */
    public function instagramWebhook(ShortformRepository $repository, Clock $clock): InstagramWebhookController
    {
        $publishing = new PublishWebhookController(
            $repository,
            Env::get('IG_VERIFY_TOKEN', '') ?? '',
            new MetaWebhookSignatureVerifier(Env::get('IG_APP_SECRET', '') ?? ''),
            $clock,
        );

        return new InstagramWebhookController(
            $publishing,
            new CommentsWebhookController($this->dispatcher),
            new MetaWebhookSignatureVerifier(Env::get('IG_APP_SECRET', '') ?? ''),
        );
    }

    /**
     * Signing keys, newest first; the previous one stays valid for links already sent
     * (15 minute TTL). Missing in production is a hard failure: a known default key would
     * let anyone mint working coupon links.
     *
     * @return list<string>
     */
    private static function signingKeys(): array
    {
        $current = Env::get('COUPON_TOKEN_SIGNING_KEY');
        $previous = Env::get('COUPON_TOKEN_SIGNING_KEY_OLD');

        if ($current === null && $previous === null) {
            if (Env::get('APP_ENV', 'local') === 'production') {
                throw new \RuntimeException('COUPON_TOKEN_SIGNING_KEY is required in production.');
            }

            return ['shortform-local-coupon-signing-key-not-for-production'];
        }

        return array_values(array_filter([$current, $previous], static fn (?string $k): bool => $k !== null && $k !== ''));
    }

    private static function pseudonymKey(): string
    {
        return Env::get('COUPON_HASH_KEY')
            ?? Env::get('COUPON_TOKEN_SIGNING_KEY')
            ?? 'shortform-local-hash-key-not-for-production';
    }
}
