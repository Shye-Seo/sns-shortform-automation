<?php

declare(strict_types=1);

namespace Shortform\Tests\Services;

use PHPUnit\Framework\TestCase;
use Shortform\Domain\Interactive\FraudVerdict;
use Shortform\Domain\Interactive\WebhookComment;
use Shortform\Services\FraudDetectionService;
use Shortform\Tests\Support\FakeInteractionEventStore;
use Shortform\Tests\Support\MutableClock;

/**
 * Fraud scoring contract tests.
 *
 * The weights are a product decision, so they are asserted exactly: if someone changes +40 to
 * +30, this file fails and the change becomes visible in review instead of silently letting
 * more macro accounts through.
 */
final class FraudDetectionServiceTest extends TestCase
{
    private const NOW = '2026-11-10T10:00:00+09:00';

    private FakeInteractionEventStore $events;

    private MutableClock $clock;

    private FraudDetectionService $service;

    protected function setUp(): void
    {
        $this->events = new FakeInteractionEventStore();
        $this->clock = MutableClock::at(self::NOW);
        $this->service = new FraudDetectionService($this->events);
    }

    private function comment(
        string $author = 'author-1',
        string $text = '할인 받고 싶어요',
        bool $newAccount = false,
    ): WebhookComment {
        return new WebhookComment(
            externalEventId: 'evt-' . $author,
            platform: 'instagram',
            contentRef: 'reels_1789',
            authorRef: $author,
            authorHandleRef: 'handle',
            text: $text,
            receivedAt: new \DateTimeImmutable(self::NOW),
            isNewAccount: $newAccount,
        );
    }

    public function testCleanCommentScoresZero(): void
    {
        $verdict = $this->service->assess($this->comment());

        self::assertSame(0, $verdict->score);
        self::assertSame([], $verdict->reasons);
        self::assertFalse($verdict->isBlocked());
    }

    public function testAuthorBurstIsFortyPointsAndNotBlockedAlone(): void
    {
        $this->events->authorCounts['author-1'] = 3;

        $verdict = $this->service->assess($this->comment());

        self::assertSame(40, $verdict->score);
        self::assertContains(FraudDetectionService::AUTHOR_BURST, $verdict->reasons);
        self::assertFalse($verdict->isBlocked(), '한 신호만으로는 막지 않는다(오탐 비용이 더 크다).');
    }

    public function testAuthorBurstPlusNewAccountBlocks(): void
    {
        $this->events->authorCounts['author-1'] = 4;

        $verdict = $this->service->assess($this->comment(newAccount: true));

        self::assertSame(60, $verdict->score);
        self::assertTrue($verdict->isBlocked());
        self::assertContains(FraudDetectionService::NEW_ACCOUNT, $verdict->reasons);
    }

    public function testSubnetFloodIsThirtyPoints(): void
    {
        $this->events->subnetCounts['203.0.113.0/24'] = 20;

        $verdict = $this->service->assess($this->comment(), '203.0.113.45');

        self::assertSame(30, $verdict->score);
        self::assertContains(FraudDetectionService::SUBNET_FLOOD, $verdict->reasons);
    }

    public function testSubnetBelowThresholdIsNotFlagged(): void
    {
        $this->events->subnetCounts['203.0.113.0/24'] = 19;

        $verdict = $this->service->assess($this->comment(), '203.0.113.45');

        self::assertSame(0, $verdict->score);
    }

    public function testShortTextIsSpam(): void
    {
        $verdict = $this->service->assess($this->comment(text: '할인')); // 정규화 후 2자

        self::assertSame(15, $verdict->score);
        self::assertContains(FraudDetectionService::SPAM_TEXT, $verdict->reasons);
    }

    public function testRepeatedBodyIsSpam(): void
    {
        $this->events->bodyCounts['할인받고싶어요'] = 5;

        $verdict = $this->service->assess($this->comment());

        self::assertSame(15, $verdict->score);
        self::assertContains(FraudDetectionService::SPAM_TEXT, $verdict->reasons);
    }

    public function testRateLimitPlusNewAccountBlocks(): void
    {
        $verdict = $this->service->assess($this->comment(newAccount: true), null, true);

        self::assertSame(55, $verdict->score);
        self::assertTrue($verdict->isBlocked());
    }

    public function testScoreIsCappedAtOneHundred(): void
    {
        $this->events->authorCounts['author-1'] = 10;
        $this->events->subnetCounts['203.0.113.0/24'] = 100;
        $this->events->bodyCounts['할인'] = 50;

        $verdict = $this->service->assess($this->comment(text: '할인', newAccount: true), '203.0.113.9', true);

        self::assertSame(100, $verdict->score);
    }

    public function testSubnetNormalisationGroupsHosts(): void
    {
        self::assertSame('203.0.113.0/24', FraudDetectionService::subnetOf('203.0.113.77'));
        self::assertSame('203.0.112.0/24', FraudDetectionService::subnetOf('203.0.112.1'));
        self::assertNull(FraudDetectionService::subnetOf('not-an-ip'));
        self::assertNull(FraudDetectionService::subnetOf(null));
        self::assertStringEndsWith('::/64', (string) FraudDetectionService::subnetOf('2001:db8:1:2::5'));
    }

    public function testBlockThresholdMatchesSchema(): void
    {
        self::assertSame(50, FraudVerdict::BLOCK_THRESHOLD);
        self::assertFalse((new FraudVerdict(49, []))->isBlocked());
        self::assertTrue((new FraudVerdict(50, []))->isBlocked());
    }

    public function testDescriptionIsOperatorReadable(): void
    {
        $verdict = $this->service->assess($this->comment(newAccount: true));

        self::assertStringContainsString('가입 24시간 이내', $this->service->describe($verdict));
    }
}
