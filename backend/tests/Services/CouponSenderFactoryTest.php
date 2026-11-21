<?php

declare(strict_types=1);

namespace Shortform\Tests\Services;

use PHPUnit\Framework\TestCase;
use Shortform\Repositories\SendResult;
use Shortform\Services\Messaging\CouponMessageComposer;
use Shortform\Services\Messaging\CouponSenderFactory;
use Shortform\Services\Messaging\DryRunNotificationSender;
use Shortform\Services\Messaging\RoutingNotificationSender;
use Shortform\Services\Messaging\UnconfiguredNotificationSender;
use Shortform\Tests\Support\FixedClock;
use Shortform\Tests\Support\StubHttpClient;

/**
 * Transport selection.
 *
 * The default must be the dry-run transport: running the worker locally must never DM a real
 * person because an env var was missing. `live` without credentials must fail at boot rather
 * than degrade quietly into "sent" rows that never left.
 */
final class CouponSenderFactoryTest extends TestCase
{
    private StubHttpClient $http;

    /** @var list<string> */
    private const TOUCHED = [
        'COUPON_SENDER',
        'IG_BUSINESS_ACCOUNT_ID',
        'IG_ACCESS_TOKEN',
        'SENS_ACCESS_KEY',
        'SENS_SECRET_KEY',
        'SENS_SERVICE_ID',
    ];

    /** @var array<string,string|false> */
    private array $saved = [];

    protected function setUp(): void
    {
        $this->http = new StubHttpClient();
        foreach (self::TOUCHED as $key) {
            $this->saved[$key] = getenv($key);
            putenv($key);
        }
    }

    protected function tearDown(): void
    {
        foreach ($this->saved as $key => $value) {
            if ($value === false) {
                putenv($key);
            } else {
                putenv($key . '=' . $value);
            }
        }
    }

    public function testDefaultIsDryRun(): void
    {
        self::assertInstanceOf(DryRunNotificationSender::class, $this->factory());
    }

    public function testLiveWithoutCredentialsFailsAtBoot(): void
    {
        putenv('COUPON_SENDER=live');

        $this->expectException(\RuntimeException::class);
        $this->factory();
    }

    public function testAutoFallsBackToDryRunWhenNothingIsConfigured(): void
    {
        putenv('COUPON_SENDER=auto');

        self::assertInstanceOf(DryRunNotificationSender::class, $this->factory());
    }

    public function testLiveRoutesEachChannelAndFailsTheMissingOne(): void
    {
        putenv('COUPON_SENDER=live');
        putenv('IG_BUSINESS_ACCOUNT_ID=17841400000000000');
        putenv('IG_ACCESS_TOKEN=ig-token');

        $sender = $this->factory();
        self::assertInstanceOf(RoutingNotificationSender::class, $sender);

        $this->http->queueJson(200, ['message_id' => 'mid.1']);
        $sent = $sender->send('INSTAGRAM_DM', 'author-1', ['deepLink' => 'https://coupon.shye.kr/c/x']);
        self::assertTrue($sent->ok);
        self::assertSame('instagram', $sent->provider);

        $alimtalk = $sender->send('ALIMTALK', '01012345678', ['deepLink' => 'https://coupon.shye.kr/c/x']);
        self::assertFalse($alimtalk->ok);
        self::assertFalse($alimtalk->retryable, '자격 증명 없음은 재시도로 풀리지 않는다.');
        self::assertStringContainsString('SENS_ACCESS_KEY', $alimtalk->error);
    }

    public function testUnknownModeIsRejected(): void
    {
        putenv('COUPON_SENDER=carrier-pigeon');

        $this->expectException(\InvalidArgumentException::class);
        $this->factory();
    }

    public function testDryRunMessageIdIsDeterministicAndMarked(): void
    {
        $sender = new DryRunNotificationSender();
        $payload = ['deepLink' => 'https://coupon.shye.kr/c/x', 'commentId' => 'c-1'];

        $first = $sender->send('INSTAGRAM_DM', 'author-1', $payload);
        $second = $sender->send('INSTAGRAM_DM', 'author-1', $payload);

        self::assertTrue($first->ok);
        self::assertSame('dry_run', $first->provider);
        self::assertStringStartsWith('dryrun_', (string) $first->messageId);
        self::assertSame($first->messageId, $second->messageId);
    }

    public function testUnconfiguredSenderIsAPermanentFailure(): void
    {
        $result = (new UnconfiguredNotificationSender('no keys'))->send('ALIMTALK', '01012345678', []);

        self::assertSame('PERMANENT_FAILURE', $result->outcome());
        self::assertStringContainsString('no keys', $result->error);
    }

    public function testComposerRequiresADeepLink(): void
    {
        $composer = new CouponMessageComposer();

        $this->expectException(\InvalidArgumentException::class);
        $composer->compose(['rewardLabel' => '3,000원']);
    }

    public function testComposerCapsLongBodies(): void
    {
        $text = (new CouponMessageComposer())->compose([
            'deepLink' => 'https://coupon.shye.kr/c/' . str_repeat('b', 500),
            'rewardLabel' => '3,000원 즉시 할인',
        ], 120);

        self::assertLessThanOrEqual(120, mb_strlen($text));
    }

    public function testSendResultOutcomeNames(): void
    {
        self::assertSame('SENT', SendResult::delivered('x')->outcome());
        self::assertSame('RETRYABLE_FAILURE', SendResult::retryableFailure('x')->outcome());
        self::assertSame('PERMANENT_FAILURE', SendResult::permanentFailure('x')->outcome());
    }

    private function factory(): \Shortform\Repositories\NotificationSender
    {
        return CouponSenderFactory::fromEnv($this->http, FixedClock::at());
    }
}
