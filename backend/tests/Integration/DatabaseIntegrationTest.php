<?php

declare(strict_types=1);

namespace Shortform\Tests\Integration;

use PHPUnit\Framework\TestCase;
use Shortform\Database\Connection;
use Shortform\Repositories\ShortformRepository;
use Shortform\Repositories\WebhookApplyResult;
use Shortform\Support\Env;

/**
 * Live MySQL 8.0 tests. These prove the properties that unit tests cannot:
 *  - `FOR UPDATE SKIP LOCKED` hands each job to exactly one worker
 *  - progress is monotonic, failure routing picks delayed/dlq from the row itself
 *  - a dead worker's lease is reclaimed
 *  - one publish row per (project, platform) with attempts incremented on retry
 *  - webhook redelivery does not apply twice
 *  - notification dedupe is enforced by the unique key, not by application logic
 *
 *   SELLERSCOPE-style gate: set SHORTFORM_INTEGRATION=1 with a migrated database.
 */
final class DatabaseIntegrationTest extends TestCase
{
    private Connection $connection;
    private ShortformRepository $repository;
    private int $tenantId = 0;
    private int $accountId = 0;
    private int $projectId = 0;

    protected function setUp(): void
    {
        if (Env::get('SHORTFORM_INTEGRATION') !== '1') {
            self::markTestSkipped('Set SHORTFORM_INTEGRATION=1 with a migrated MySQL 8.0 to run.');
        }

        $this->connection = Connection::fromEnv();
        $this->repository = new ShortformRepository($this->connection);
        $pdo = $this->connection->pdo();

        // FK order matters: projects reference creator_accounts with ON DELETE RESTRICT,
        // so a tenant delete cannot cascade past an existing project.
        $existing = $pdo->prepare('SELECT id FROM tenants WHERE code = ?');
        $existing->execute(['it-agency']);
        $oldId = $existing->fetchColumn();
        if ($oldId !== false) {
            $pdo->prepare('DELETE FROM shortform_projects WHERE tenant_id = ?')->execute([$oldId]);
            $pdo->prepare('DELETE FROM creator_accounts WHERE tenant_id = ?')->execute([$oldId]);
            $pdo->prepare('DELETE FROM tenants WHERE id = ?')->execute([$oldId]);
        }

        // Sweep any leftovers from an interrupted earlier run (same handle, orphaned rows).
        $leftover = $pdo->query("SELECT id FROM creator_accounts WHERE handle = '@it_account'")->fetchAll(\PDO::FETCH_COLUMN);
        foreach ($leftover as $accountId) {
            $pdo->prepare('DELETE FROM shortform_projects WHERE creator_account_id = ?')->execute([(int) $accountId]);
            $pdo->prepare('DELETE FROM creator_accounts WHERE id = ?')->execute([(int) $accountId]);
        }
        $pdo->prepare(
            "INSERT INTO tenants (code, name, plan, monthly_render_quota, status) VALUES ('it-agency', '통합테스트 대행사', 'growth', 100, 'active')"
        )->execute();
        $this->tenantId = (int) $pdo->lastInsertId();

        $pdo->prepare(
            "INSERT INTO creator_accounts (tenant_id, platform, handle, external_account_id, token_expires_at, status)
             VALUES (?, 'instagram-reels', '@it_account', '17841400000000001', DATE_ADD(NOW(), INTERVAL 30 DAY), 'active')"
        )->execute([$this->tenantId]);
        $this->accountId = (int) $pdo->lastInsertId();

        $this->projectId = $this->repository->createProject(
            $this->tenantId,
            $this->accountId,
            'it-key-1',
            '통합테스트 영상',
            '테스트 주제',
            ['beats' => ['hook', 'problem', 'solution', 'cta']],
            '캡션 본문',
            ['#테스트'],
            'instagram-reels',
            new \DateTimeImmutable('2026-11-11 09:00:00'),
        );
    }

    protected function tearDown(): void
    {
        if (!isset($this->connection)) {
            return;
        }
        // Ordered cleanup: projects hold the RESTRICT reference to creator_accounts.
        $pdo = $this->connection->pdo();
        $pdo->prepare('DELETE FROM shortform_projects WHERE tenant_id = ?')->execute([$this->tenantId]);
        $pdo->prepare('DELETE FROM creator_accounts WHERE tenant_id = ?')->execute([$this->tenantId]);
        $pdo->prepare('DELETE FROM tenants WHERE id = ?')->execute([$this->tenantId]);
    }

    private function now(): \DateTimeImmutable
    {
        return new \DateTimeImmutable('2026-11-11 09:00:00');
    }

    public function testProjectCreationIsIdempotentPerKey(): void
    {
        $again = $this->repository->createProject(
            $this->tenantId,
            $this->accountId,
            'it-key-1',
            '다른 제목',
            '다른 주제',
            [],
            '다른 캡션',
            [],
            'instagram-reels',
            $this->now(),
        );

        self::assertSame($this->projectId, $again, '같은 멱등 키는 같은 프로젝트를 돌려준다(영상이 두 번 만들어지지 않는다).');
    }

    public function testEnqueueIsIdempotentByDedupeKey(): void
    {
        $first = $this->repository->enqueue($this->tenantId, $this->projectId, 'instagram-reels', 7, ['durationSec' => 45], 'dedupe-1', $this->now());
        $second = $this->repository->enqueue($this->tenantId, $this->projectId, 'instagram-reels', 7, ['durationSec' => 45], 'dedupe-1', $this->now());

        self::assertSame($first, $second);

        $count = (int) $this->connection->pdo()->query(
            "SELECT COUNT(*) FROM render_jobs WHERE project_id = {$this->projectId}"
        )->fetchColumn();
        self::assertSame(1, $count);
    }

    public function testClaimMovesJobToActiveWithLeaseAndOnlyOneWorkerWins(): void
    {
        $this->repository->enqueue($this->tenantId, $this->projectId, 'instagram-reels', 7, ['durationSec' => 45], 'dedupe-claim', $this->now());

        $workerA = $this->repository->claimNext('worker-a', 300, $this->tenantId, $this->now());
        $workerB = $this->repository->claimNext('worker-b', 300, $this->tenantId, $this->now());

        self::assertNotNull($workerA);
        self::assertNull($workerB, '한 잡은 한 워커에게만 간다(SKIP LOCKED).');
        self::assertSame('worker-a', $workerA['worker_id']);
        self::assertSame(1, (int) $workerA['attempts']);
        self::assertNotNull($workerA['lease_expires_at']);
    }

    public function testProgressNeverMovesBackwards(): void
    {
        $this->repository->enqueue($this->tenantId, $this->projectId, 'instagram-reels', 5, [], 'dedupe-progress', $this->now());
        $job = $this->repository->claimNext('worker-a', 300, $this->tenantId, $this->now());
        $jobId = (int) $job['id'];

        $this->repository->updateProgress($jobId, 80.0, $this->now());
        $this->repository->updateProgress($jobId, 35.0, $this->now());

        $progress = $this->connection->pdo()->query("SELECT progress FROM render_jobs WHERE id = {$jobId}")->fetchColumn();
        self::assertSame('80.00', (string) $progress);
    }

    public function testRetryableFailureIsDelayedThenDlqAtMaxAttempts(): void
    {
        $pdo = $this->connection->pdo();
        $pdo->prepare(
            "INSERT INTO render_jobs (tenant_id, project_id, platform, state, attempts, max_attempts, payload, available_at)
             VALUES (?, ?, 'instagram-reels', 'active', 1, 2, '{}', ?)"
        )->execute([$this->tenantId, $this->projectId, $this->now()->format('Y-m-d H:i:s.v')]);
        $jobId = (int) $pdo->lastInsertId();

        $this->repository->fail($jobId, 'encoder OOM', true, $this->now());
        $row = $pdo->query("SELECT state, available_at FROM render_jobs WHERE id = {$jobId}")->fetch();
        self::assertSame('delayed', $row['state'], '재시도 가능한 실패는 지연 재시도로 돌아간다.');

        // Second attempt exhausts max_attempts → DLQ, keeping last_error for the operator.
        $pdo->exec("UPDATE render_jobs SET attempts = 2, state = 'active' WHERE id = {$jobId}");
        $this->repository->fail($jobId, 'encoder OOM', true, $this->now());
        $row = $pdo->query("SELECT state, last_error, finished_at FROM render_jobs WHERE id = {$jobId}")->fetch();
        self::assertSame('dlq', $row['state']);
        self::assertStringContainsString('encoder OOM', (string) $row['last_error']);
        self::assertNotNull($row['finished_at']);
    }

    public function testNonRetryableFailureGoesStraightToFailed(): void
    {
        $this->repository->enqueue($this->tenantId, $this->projectId, 'instagram-reels', 5, [], 'dedupe-fail', $this->now());
        $job = $this->repository->claimNext('worker-a', 300, $this->tenantId, $this->now());

        $this->repository->fail((int) $job['id'], 'unsupported codec', false, $this->now());

        $state = $this->connection->pdo()->query("SELECT state FROM render_jobs WHERE id = {$job['id']}")->fetchColumn();
        self::assertSame('failed', $state);
    }

    public function testStalledJobIsReclaimed(): void
    {
        $pdo = $this->connection->pdo();
        $pdo->prepare(
            "INSERT INTO render_jobs (tenant_id, project_id, platform, state, attempts, max_attempts, payload,
                                      available_at, worker_id, lease_expires_at)
             VALUES (?, ?, 'instagram-reels', 'active', 1, 3, '{}', ?, 'dead-worker', ?)"
        )->execute([
            $this->tenantId,
            $this->projectId,
            $this->now()->format('Y-m-d H:i:s.v'),
            $this->now()->modify('-10 minutes')->format('Y-m-d H:i:s.v'),
        ]);
        $jobId = (int) $pdo->lastInsertId();

        $reclaimed = $this->repository->reclaimStalled(10, $this->now());

        self::assertGreaterThanOrEqual(1, $reclaimed);
        $row = $pdo->query("SELECT state, worker_id, last_error FROM render_jobs WHERE id = {$jobId}")->fetch();
        self::assertSame('delayed', $row['state']);
        self::assertNull($row['worker_id']);
        self::assertStringContainsString('stalled', (string) $row['last_error']);
    }

    public function testCompletionUpdatesJobAndProject(): void
    {
        $this->repository->enqueue($this->tenantId, $this->projectId, 'instagram-reels', 9, ['durationSec' => 45], 'dedupe-done', $this->now());
        $job = $this->repository->claimNext('worker-a', 300, $this->tenantId, $this->now());

        $this->repository->complete((int) $job['id'], ['chunks' => 4, 'encodedSec' => 45.0], '/renders/it.mp4', $this->now());

        $row = $this->connection->pdo()->query("SELECT state, progress, result FROM render_jobs WHERE id = {$job['id']}")->fetch();
        self::assertSame('completed', $row['state']);
        self::assertSame('100.00', (string) $row['progress']);
        self::assertStringContainsString('/renders/it.mp4', (string) $row['result']);

        $projectStatus = $this->connection->pdo()->query("SELECT status FROM shortform_projects WHERE id = {$this->projectId}")->fetchColumn();
        self::assertSame('rendered', $projectStatus);
    }

    public function testOnePublishRowPerProjectAndPlatformWithAttemptCounter(): void
    {
        $first = $this->repository->startPublish($this->tenantId, $this->projectId, $this->accountId, 'instagram-reels', str_repeat('a', 64), ['a' => 1], $this->now());
        $second = $this->repository->startPublish($this->tenantId, $this->projectId, $this->accountId, 'instagram-reels', str_repeat('b', 64), ['a' => 2], $this->now());

        self::assertSame($first, $second);

        $row = $this->connection->pdo()->query("SELECT attempts, caption_hash FROM publish_logs WHERE id = {$first}")->fetch();
        self::assertSame(1, (int) $row['attempts'], '재시도는 행을 늘리지 않고 attempts를 올린다.');
        self::assertSame(str_repeat('b', 64), $row['caption_hash']);
    }

    public function testPublishLifecycleRecordsMediaAndPermalink(): void
    {
        $id = $this->repository->startPublish($this->tenantId, $this->projectId, $this->accountId, 'instagram-reels', str_repeat('c', 64), [], $this->now());
        $this->repository->markContainer($id, 'container-it-1', $this->now());
        $this->repository->markPublished($id, $this->projectId, 'media-it-1', 'https://www.instagram.com/reel/it/', 4, 25, $this->now());

        $row = $this->connection->pdo()->query("SELECT status, container_id, media_id, permalink, quota_used FROM publish_logs WHERE id = {$id}")->fetch();
        self::assertSame('published', $row['status']);
        self::assertSame('container-it-1', $row['container_id']);
        self::assertSame('https://www.instagram.com/reel/it/', $row['permalink']);
        self::assertSame(4, (int) $row['quota_used']);

        $project = $this->connection->pdo()->query("SELECT status, published_at FROM shortform_projects WHERE id = {$this->projectId}")->fetch();
        self::assertSame('published', $project['status']);
        self::assertNotNull($project['published_at']);
    }

    public function testWebhookRedeliveryIsAppliedOnce(): void
    {
        $id = $this->repository->startPublish($this->tenantId, $this->projectId, $this->accountId, 'instagram-reels', str_repeat('d', 64), [], $this->now());
        $this->repository->markPublished($id, $this->projectId, 'media-it-2', null, 1, 25, $this->now());

        $first = $this->repository->applyWebhookEvent('media-it-2', 'evt-1', 'published', ['permalink' => 'https://ig/p/1'], $this->now());
        $second = $this->repository->applyWebhookEvent('media-it-2', 'evt-1', 'published', ['permalink' => 'https://ig/p/1'], $this->now());

        self::assertSame(WebhookApplyResult::Applied, $first);
        self::assertSame(WebhookApplyResult::Duplicate, $second, '같은 이벤트 id의 재전송은 0행 갱신 → 중복 집계 없음.');
        self::assertSame(
            WebhookApplyResult::Unknown,
            $this->repository->applyWebhookEvent('media-not-ours', 'evt-9', 'published', [], $this->now()),
        );

        $row = $this->connection->pdo()->query("SELECT permalink, last_event_id FROM publish_logs WHERE id = {$id}")->fetch();
        self::assertSame('https://ig/p/1', $row['permalink']);
        self::assertSame('evt-1', $row['last_event_id']);
    }

    public function testNotificationDedupeIsEnforcedByUniqueKey(): void
    {
        $now = $this->now();
        $first = $this->repository->claim($this->tenantId, $this->projectId, 'render_completed', 'notify:it:1', 'SF_RENDER_DONE', '@shortform', '01012345678', ['a' => 1], $now);
        $second = $this->repository->claim($this->tenantId, $this->projectId, 'render_completed', 'notify:it:1', 'SF_RENDER_DONE', '@shortform', '01012345678', ['a' => 1], $now);

        self::assertNotNull($first);
        self::assertNull($second);

        $row = $this->connection->pdo()->query("SELECT recipient_phone, status FROM alimtalk_notifications WHERE id = {$first}")->fetch();
        self::assertSame('010-****-5678', $row['recipient_phone']);
        self::assertSame('queued', $row['status']);
    }

    public function testHookExperimentVariantsAreValidatedByCheckConstraint(): void
    {
        $this->expectException(\PDOException::class);

        // CHECK (JSON_LENGTH(variants) BETWEEN 2 AND 4) — one variant is not an experiment.
        $this->connection->pdo()->exec(
            "INSERT INTO hook_experiments (tenant_id, project_id, hypothesis, variants)
             VALUES ({$this->tenantId}, {$this->projectId}, 'invalid', JSON_ARRAY(JSON_OBJECT('id','A')))"
        );
    }
}
