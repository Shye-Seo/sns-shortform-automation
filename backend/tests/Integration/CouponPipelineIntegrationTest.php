<?php

declare(strict_types=1);

namespace Shortform\Tests\Integration;

use PHPUnit\Framework\TestCase;
use Shortform\Controllers\CommentsWebhookController;
use Shortform\Controllers\InstagramWebhookController;
use Shortform\Controllers\PublishWebhookController;
use Shortform\Database\Connection;
use Shortform\Domain\Interactive\ClaimToken;
use Shortform\Http\Request;
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
use Shortform\Services\Messaging\DryRunNotificationSender;
use Shortform\Support\DbTime;
use Shortform\Support\Env;
use Shortform\Tests\Support\MutableClock;
use Shortform\Tests\Support\ScriptedNotificationSender;

/**
 * Live MySQL coupon pipeline.
 *
 * These are the properties the unit tests cannot prove:
 *   · the HTTP payload really lands in webhook_interaction_events and dispatch_queue
 *   · `FOR UPDATE SKIP LOCKED` + CLAIMED hands each row to one worker
 *   · the token is attached to the queue row and `claim_count = 0` CAS rejects the second click
 *   · attempts are counted in SQL and the third retryable failure ends in DEAD_LETTER
 *   · the fraud counters read the stored subnet / normalised body, not an empty column
 *
 *   SHORTFORM_INTEGRATION=1 + migrated database. Queries and claims are scoped to this
 *   test's campaign, so the demo seed can be present.
 */
final class CouponPipelineIntegrationTest extends TestCase
{
    private const APP_SECRET = 'it-app-secret';
    private const CONTENT_REF = 'it_reels_1789';

    private Connection $connection;

    private \PDO $pdo;

    private MutableClock $clock;

    private MySqlCampaignCatalog $campaigns;

    private MySqlInteractionEventStore $events;

    private MySqlDispatchQueueStore $queue;

    private MySqlClaimTokenStore $tokens;

    private MySqlDispatchAttemptStore $attempts;

    private int $tenantId = 0;

    private int $campaignId = 0;

    private int $sequence = 0;

    protected function setUp(): void
    {
        if (Env::get('SHORTFORM_INTEGRATION') !== '1') {
            self::markTestSkipped('Set SHORTFORM_INTEGRATION=1 with a migrated MySQL 8.0 to run.');
        }

        $this->connection = Connection::fromEnv();
        $this->pdo = $this->connection->pdo();
        $this->clock = MutableClock::at((new \DateTimeImmutable('now', DbTime::zone()))->format(\DateTimeInterface::ATOM));

        $this->pdo->prepare("DELETE FROM tenants WHERE code = 'it-coupon'")->execute();
        $this->pdo->prepare(
            "INSERT INTO tenants (code, name, plan, monthly_render_quota, status) VALUES ('it-coupon', '쿠폰 통합테스트', 'growth', 100, 'active')"
        )->execute();
        $this->tenantId = (int) $this->pdo->lastInsertId();

        $now = $this->clock->now();
        $this->pdo->prepare(
            "INSERT INTO interactive_campaigns
                (tenant_id, code, name, platform, content_ref, trigger_keywords, reward_label, reward_amount,
                 total_reward_budget, claim_limit, max_claims_per_user, token_ttl_minutes, starts_at, ends_at, status)
             VALUES (?, 'it-drop-1', '통합테스트 드롭', 'instagram', ?, JSON_ARRAY('할인','쿠폰'), '3,000원 즉시 할인',
                     3000, 3000000, 1000, 1, 15, ?, ?, 'live')"
        )->execute([
            $this->tenantId,
            self::CONTENT_REF,
            DbTime::format($now->modify('-1 hour')),
            DbTime::format($now->modify('+1 day')),
        ]);
        $this->campaignId = (int) $this->pdo->lastInsertId();

        $this->campaigns = new MySqlCampaignCatalog($this->connection);
        $this->events = new MySqlInteractionEventStore($this->connection, new Pseudonymizer('it-hash-key'));
        $this->queue = new MySqlDispatchQueueStore($this->connection, 120);
        $this->tokens = new MySqlClaimTokenStore($this->connection);
        $this->attempts = new MySqlDispatchAttemptStore($this->connection);
    }

    protected function tearDown(): void
    {
        if ($this->tenantId === 0) {
            return;
        }
        $this->pdo->prepare('DELETE FROM tenants WHERE id = ?')->execute([$this->tenantId]);
    }

    // ── helpers ──────────────────────────────────────────────────

    private function dispatcher(
        ?\Shortform\Repositories\NotificationSender $sender = null,
        int $maxAttempts = 3,
    ): InteractiveCouponDispatcher {
        return new InteractiveCouponDispatcher(
            $this->campaigns,
            $this->events,
            $this->queue,
            $this->tokens,
            $sender ?? new DryRunNotificationSender(),
            new HmacTokenSigner('it-signing-key-32-bytes-long!!!!'),
            new FraudDetectionService($this->events),
            $this->clock,
            slaSeconds: 60,
            maxAttempts: $maxAttempts,
            deepLinkBase: 'https://coupon.test/c',
            attempts: $this->attempts,
        );
    }

    private function dispatch(InteractiveCouponDispatcher $dispatcher, int $limit = 10): \Shortform\Domain\Interactive\DispatchReport
    {
        // Scoped to this test's campaign: on a seeded demo database the seed's PENDING rows
        // are also past their deadline and would otherwise fill the claim.
        return $dispatcher->dispatchPending($limit, 'it-worker', $this->campaignId);
    }

    private function webhook(InteractiveCouponDispatcher $dispatcher): InstagramWebhookController
    {
        return new InstagramWebhookController(
            new PublishWebhookController(
                new ShortformRepository($this->connection),
                'it-verify-token',
                new MetaWebhookSignatureVerifier(self::APP_SECRET),
                $this->clock,
            ),
            new CommentsWebhookController($dispatcher),
            new MetaWebhookSignatureVerifier(self::APP_SECRET),
        );
    }

    private function nextCommentId(): string
    {
        $this->sequence++;

        return 'it_comment_' . $this->sequence . '_' . bin2hex(random_bytes(3));
    }

    private function commentId(string $text = '할인 받고 싶어요', string $author = 'it-author'): array
    {
        return [
            'id' => $this->nextCommentId(),
            'text' => $text,
            'from' => ['id' => $author, 'username' => 'it_user'],
            'media' => ['id' => self::CONTENT_REF],
        ];
    }

    /** @param array<string,mixed> $value */
    private function body(array $value): string
    {
        return json_encode([
            'object' => 'instagram',
            'entry' => [[
                'id' => 'it-ig-account',
                'time' => $this->clock->now()->getTimestamp(),
                'changes' => [['field' => 'comments', 'value' => $value]],
            ]],
        ], JSON_UNESCAPED_UNICODE) ?: '{}';
    }

    private function deliver(InstagramWebhookController $webhook, string $body, string $ip = '203.0.113.10'): array
    {
        return $webhook->receive(new Request(
            'POST',
            '/webhooks/instagram',
            ['x-hub-signature-256' => 'sha256=' . hash_hmac('sha256', $body, self::APP_SECRET)],
            [],
            [],
            $body,
            $ip,
        ));
    }

    private function queueRows(): array
    {
        $stmt = $this->pdo->prepare('SELECT * FROM dispatch_queue WHERE campaign_id = ? ORDER BY id');
        $stmt->execute([$this->campaignId]);

        return $stmt->fetchAll();
    }

    private function eventRows(): array
    {
        $stmt = $this->pdo->prepare('SELECT * FROM webhook_interaction_events WHERE campaign_id = ? ORDER BY id');
        $stmt->execute([$this->campaignId]);

        return $stmt->fetchAll();
    }

    // ── end to end ───────────────────────────────────────────────

    public function testWebhookQueueWorkerDispatchAndClaim(): void
    {
        $dispatcher = $this->dispatcher();
        $webhook = $this->webhook($dispatcher);
        $comment = $this->commentId();

        $response = $this->deliver($webhook, $this->body($comment));

        self::assertSame(1, $response['comments']['enqueued'], '서명된 댓글이 큐에 들어가야 한다.');
        self::assertSame(0, $response['ignored']);

        $events = $this->eventRows();
        self::assertCount(1, $events);
        self::assertSame('QUEUED', $events[0]['processing_status']);
        self::assertSame('할인', $events[0]['matched_keyword']);
        self::assertSame(64, strlen((string) $events[0]['author_platform_id']), '작성자 id는 원문이 아니라 HMAC이어야 한다.');
        self::assertNotSame('it-author', $events[0]['author_platform_id']);
        self::assertSame('203.0.113.0/24', $events[0]['client_subnet']);

        $rows = $this->queueRows();
        self::assertCount(1, $rows);
        self::assertSame('PENDING', $rows[0]['status']);
        $payload = json_decode((string) $rows[0]['payload'], true);
        self::assertSame($comment['id'], $payload['commentId'], 'DM 답신에 쓸 댓글 id가 큐에 있어야 한다.');

        $report = $this->dispatch($dispatcher);
        self::assertSame(1, $report->dispatched());

        $row = $this->queueRows()[0];
        self::assertSame('DISPATCHED', $row['status']);
        self::assertNotNull($row['claim_token_id'], '발급 토큰이 큐 행에 연결되어야 한다.');
        self::assertSame('it-worker', $row['worker_id']);

        $attempt = $this->pdo->query(
            'SELECT * FROM dispatch_attempts WHERE dispatch_queue_id = ' . (int) $row['id']
        )->fetch();
        self::assertNotFalse($attempt);
        self::assertSame('SENT', $attempt['outcome']);
        self::assertSame('dry_run', $attempt['provider']);
        self::assertStringStartsWith('dryrun_', (string) $attempt['provider_message_id']);

        $event = $this->eventRows()[0];
        self::assertSame('DISPATCHED', $event['processing_status']);

        $attemptPayload = json_decode((string) $attempt['request_payload'], true);
        $deepLink = (string) $attemptPayload['deepLink'];
        $plain = rawurldecode(substr($deepLink, strrpos($deepLink, '/') + 1));

        $first = $dispatcher->claim($plain, '198.51.100.7');
        $second = $dispatcher->claim($plain, '198.51.100.7');

        self::assertTrue($first->isGranted(), '딥링크 첫 클릭은 쿠폰을 줘야 한다.');
        self::assertSame(3000, $first->rewardAmount);
        self::assertSame('ALREADY_CLAIMED', $second->outcome);

        $token = $this->pdo->query('SELECT * FROM instant_claim_tokens WHERE id = ' . (int) $row['claim_token_id'])->fetch();
        self::assertSame(1, (int) $token['is_claimed']);
        self::assertSame(1, (int) $token['claim_count']);
        self::assertNotNull($token['claimed_at']);

        $usage = $this->campaigns->usage($this->campaignId);
        self::assertSame(1, $usage['claims']);
        self::assertSame(3000, $usage['rewardTotal']);
    }

    public function testRedeliveredWebhookCreatesNoSecondEventOrQueueRow(): void
    {
        $dispatcher = $this->dispatcher();
        $webhook = $this->webhook($dispatcher);
        $body = $this->body($this->commentId());

        $this->deliver($webhook, $body);
        $second = $this->deliver($webhook, $body);

        self::assertSame(0, $second['comments']['enqueued']);
        self::assertSame(1, $second['comments']['duplicate']);
        self::assertCount(1, $this->eventRows());
        self::assertCount(1, $this->queueRows());
        self::assertSame('QUEUED', $this->eventRows()[0]['processing_status'], '중복은 기존 이벤트 상태를 바꾸지 않는다.');
    }

    public function testUnsignedBodyWritesNothing(): void
    {
        $dispatcher = $this->dispatcher();
        $webhook = $this->webhook($dispatcher);

        try {
            $webhook->receive(new Request('POST', '/webhooks/instagram', ['x-hub-signature-256' => 'sha256=deadbeef'], [], [], $this->body($this->commentId())));
            self::fail('서명이 틀린 요청이 통과했습니다.');
        } catch (\Shortform\Http\WebhookRejected) {
            // expected
        }

        self::assertCount(0, $this->eventRows());
        self::assertCount(0, $this->queueRows());
    }

    // ── queue semantics ─────────────────────────────────────────

    public function testClaimedRowIsNotHandedToASecondWorker(): void
    {
        $dispatcher = $this->dispatcher();
        $webhook = $this->webhook($dispatcher);

        $this->deliver($webhook, $this->body($this->commentId()));
        $this->deliver($webhook, $this->body($this->commentId('쿠폰 주세요', 'it-author-2')));

        $first = $this->queue->claimReady($this->clock->now(), 10, 'worker-a', $this->campaignId);
        self::assertCount(2, $first);
        self::assertSame(0, $first[0]->attempts, '반환되는 attempts는 이번 선점 이전 값이어야 한다.');

        $second = $this->queue->claimReady($this->clock->now(), 10, 'worker-b', $this->campaignId);
        self::assertSame([], $second, '선점된 행(lease 유효)은 다른 워커에게 가지 않는다.');

        $attempts = $this->pdo->query('SELECT attempts FROM dispatch_queue WHERE campaign_id = ' . $this->campaignId)->fetchAll(\PDO::FETCH_COLUMN);
        self::assertSame([1, 1], array_map('intval', $attempts));
    }

    public function testExpiredLeaseIsReclaimed(): void
    {
        $dispatcher = $this->dispatcher();
        $this->deliver($this->webhook($dispatcher), $this->body($this->commentId()));

        $this->queue->claimReady($this->clock->now(), 10, 'dead-worker', $this->campaignId);
        $this->pdo->exec('UPDATE dispatch_queue SET claimed_at = DATE_SUB(claimed_at, INTERVAL 10 MINUTE) WHERE campaign_id = ' . $this->campaignId);

        $reclaimed = $this->queue->claimReady($this->clock->now(), 10, 'next-worker', $this->campaignId);
        self::assertCount(1, $reclaimed, '죽은 워커의 선점은 lease 만료 후 회수되어야 한다.');
        self::assertSame(1, $reclaimed[0]->attempts);
    }

    public function testLateRowIsDeadLetteredWithoutSending(): void
    {
        $dispatcher = $this->dispatcher();
        $this->deliver($this->webhook($dispatcher), $this->body($this->commentId()));

        // No SQL mutation: move the clock past the 60 second SLA instead. Rewriting a
        // DATETIME in SQL would also trip the chk_dispatch_deadline constraint.
        $this->clock->advanceSeconds(120);

        $report = $this->dispatch($dispatcher);

        self::assertSame(1, $report->deadLettered());
        self::assertSame(1, $report->counts['late']);
        self::assertSame('SLA_EXCEEDED', $this->queueRows()[0]['last_error']);
        self::assertSame(0, (int) $this->pdo->query('SELECT COUNT(*) FROM dispatch_attempts WHERE campaign_id = ' . $this->campaignId)->fetchColumn());
    }

    public function testThreeRetryableFailuresEndInDeadLetterWithAttemptRows(): void
    {
        $sender = new ScriptedNotificationSender(['retryable', 'retryable', 'retryable']);
        $dispatcher = $this->dispatcher($sender, maxAttempts: 3);
        $this->deliver($this->webhook($dispatcher), $this->body($this->commentId()));

        $this->dispatch($dispatcher);
        $this->clock->advanceSeconds(1);
        $this->dispatch($dispatcher);
        $this->clock->advanceSeconds(2);
        $report = $this->dispatch($dispatcher);

        self::assertSame(1, $report->deadLettered());

        $row = $this->queueRows()[0];
        self::assertSame('DEAD_LETTER', $row['status']);
        self::assertSame(3, (int) $row['attempts']);

        $attempts = $this->pdo->query('SELECT attempt_no, outcome FROM dispatch_attempts WHERE campaign_id = ' . $this->campaignId . ' ORDER BY id')->fetchAll();
        self::assertCount(3, $attempts);
        self::assertSame([1, 2, 3], array_map('intval', array_column($attempts, 'attempt_no')));
        self::assertSame(['RETRYABLE_FAILURE'], array_values(array_unique(array_column($attempts, 'outcome'))));
    }

    // ── tokens ──────────────────────────────────────────────────

    public function testClaimIsCompareAndSetInMysql(): void
    {
        $token = $this->issueToken('it-token-cas', $this->clock->now()->modify('+15 minutes'));

        self::assertTrue($this->tokens->claim($token->id, $this->clock->now(), '198.51.100.1'));
        self::assertFalse($this->tokens->claim($token->id, $this->clock->now(), '198.51.100.2'), '두 번째 CAS는 0행이어야 한다.');

        $row = $this->pdo->query('SELECT is_claimed, claim_count FROM instant_claim_tokens WHERE id = ' . $token->id)->fetch();
        self::assertSame(1, (int) $row['is_claimed']);
        self::assertSame(1, (int) $row['claim_count']);
    }

    public function testExpiredTokenIsReportedAndMarked(): void
    {
        $token = $this->issueToken('it-token-expired', $this->clock->now()->modify('-1 minute'));

        $expired = $this->tokens->findExpired($this->clock->now(), 10);
        self::assertNotEmpty($expired);

        $this->tokens->markExpired($token->id);

        $row = $this->pdo->query('SELECT expired_at FROM instant_claim_tokens WHERE id = ' . $token->id)->fetch();
        self::assertNotNull($row['expired_at']);

        $dispatcher = $this->dispatcher();
        $result = $dispatcher->claim('never-issued', null);
        self::assertSame('NOT_FOUND', $result->outcome);
    }

    // ── fraud counters / budget ─────────────────────────────────

    public function testFraudCountersReadStoredSubnetAndNormalisedBody(): void
    {
        $dispatcher = $this->dispatcher();
        $webhook = $this->webhook($dispatcher);

        for ($i = 0; $i < 3; $i++) {
            $this->deliver($webhook, $this->body($this->commentId('할 인!!', 'same-author')), '203.0.113.' . (10 + $i));
        }

        self::assertSame(3, $this->events->countFromAuthor('same-author', $this->clock->now()->modify('-10 seconds')));
        self::assertSame(3, $this->events->countSameBody('할인', $this->clock->now()->modify('-10 seconds')));
        self::assertSame(3, $this->events->countFromSubnet('203.0.113.0/24', $this->clock->now()->modify('-10 seconds')));
    }

    public function testClaimLimitStopsFurtherEnqueue(): void
    {
        $dispatcher = $this->dispatcher();
        $webhook = $this->webhook($dispatcher);

        $this->deliver($webhook, $this->body($this->commentId()));
        $this->dispatch($dispatcher);

        $row = $this->queueRows()[0];
        $token = $this->pdo->query('SELECT * FROM instant_claim_tokens WHERE id = ' . (int) $row['claim_token_id'])->fetch();
        $this->tokens->claim((int) $token['id'], $this->clock->now(), null);

        $this->pdo->exec('UPDATE interactive_campaigns SET claim_limit = 1 WHERE id = ' . $this->campaignId);

        $second = $this->deliver($webhook, $this->body($this->commentId('쿠폰 주세요', 'it-author-3')));

        self::assertSame(0, $second['comments']['enqueued'], '장수가 소진되면 더 이상 큐에 넣지 않는다.');
        self::assertSame(1, $second['comments']['ignored']);

        $events = $this->eventRows();
        self::assertSame('IGNORED', $events[1]['processing_status']);
        self::assertSame('BUDGET_EXHAUSTED', $events[1]['rejection_reason']);
    }

    // ── fixtures ────────────────────────────────────────────────

    private function issueToken(string $uuid, \DateTimeImmutable $expiresAt): ClaimToken
    {
        $signer = new HmacTokenSigner('it-signing-key-32-bytes-long!!!!');
        $plain = $uuid . '.secret';

        $id = $this->tokens->issue(new ClaimToken(
            id: 0,
            campaignId: $this->campaignId,
            dispatchId: null,
            uuid: $uuid,
            hash: hash('sha256', $plain),
            signature: $signer->sign($uuid, $expiresAt),
            rewardAmount: 3000,
            isClaimed: false,
            claimCount: 0,
            claimedAt: null,
            expiresAt: $expiresAt,
            createdAt: $this->clock->now(),
        ));

        self::assertNotNull($id);
        $found = $this->tokens->findByHash(hash('sha256', $plain));
        self::assertNotNull($found);

        return $found;
    }
}
