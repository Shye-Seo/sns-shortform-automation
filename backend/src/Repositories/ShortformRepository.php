<?php

declare(strict_types=1);

namespace Shortform\Repositories;

use Shortform\Database\Connection;
use Shortform\Sens\AlimtalkMessage;
use Shortform\Sens\AlimtalkSendResult;
use Shortform\Sens\RecipientPhone;

/**
 * The single SQL gateway of the backend.
 *
 * Three things live here that are worth reading closely:
 *  1. Job claiming: `SELECT … FOR UPDATE SKIP LOCKED` + immediate UPDATE to `active` with a
 *     lease. Skipping locked rows is what lets N workers poll the same queue without
 *     stealing each other's work; the lease is what survives a worker being killed.
 *  2. Publish bookkeeping: one row per (project, platform). `attempts` increments on every
 *     attempt while the container id and stage timestamps stay, so a crash after
 *     "container created" can be resumed instead of re-uploaded (containers live 24h).
 *  3. Webhook idempotency: Meta re-delivers the same event for 24h. The UPDATE is guarded
 *     by `last_event_id <> :event`, so a redelivery affects 0 rows and is reported as
 *     "already applied".
 */
final class ShortformRepository implements PublishStore, JobQueueStore, NotificationStore
{
    public function __construct(private readonly Connection $connection)
    {
    }

    // ---------------------------------------------------------------- projects

    /**
     * Create a project once per (tenant, idempotency_key).
     * A retried API call must not create a second video, so the unique key decides.
     *
     * @param list<string> $hashtags
     * @param array<string,mixed> $script
     */
    public function createProject(
        int $tenantId,
        int $creatorAccountId,
        string $idempotencyKey,
        string $title,
        string $topic,
        array $script,
        string $caption,
        array $hashtags,
        string $platform,
        \DateTimeImmutable $now,
    ): int {
        $stmt = $this->connection->pdo()->prepare(
            "INSERT INTO shortform_projects
                (tenant_id, creator_account_id, platform, idempotency_key, title, topic, script, caption, hashtags,
                 status, status_events, created_at, updated_at)
             VALUES (:tenant_id, :creator, :platform, :key, :title, :topic, :script, :caption, :hashtags,
                     'scripted', :events, :now_created, :now_updated)
             ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)"
        );
        $stmt->execute([
            'tenant_id' => $tenantId,
            'creator' => $creatorAccountId,
            'platform' => $platform,
            'key' => $idempotencyKey,
            'title' => mb_substr($title, 0, 100),
            'topic' => mb_substr($topic, 0, 300),
            'script' => json_encode($script, JSON_UNESCAPED_UNICODE),
            'caption' => mb_substr($caption, 0, 2200),
            'hashtags' => json_encode($hashtags, JSON_UNESCAPED_UNICODE),
            'events' => json_encode([['from' => null, 'to' => 'scripted', 'at' => $now->format('c'), 'reason' => 'created']], JSON_UNESCAPED_UNICODE),
            'now_created' => $now->format('Y-m-d H:i:s.v'),
            'now_updated' => $now->format('Y-m-d H:i:s.v'),
        ]);

        return (int) $this->connection->pdo()->lastInsertId();
    }

    /** @return array<string,mixed>|null */
    public function findProject(int $projectId): ?array
    {
        $stmt = $this->connection->pdo()->prepare('SELECT * FROM shortform_projects WHERE id = :id');
        $stmt->execute(['id' => $projectId]);
        $row = $stmt->fetch();

        return $row === false ? null : $row;
    }

    /** @return array<string,mixed>|null */
    public function findCreatorAccount(int $creatorAccountId): ?array
    {
        $stmt = $this->connection->pdo()->prepare('SELECT * FROM creator_accounts WHERE id = :id');
        $stmt->execute(['id' => $creatorAccountId]);
        $row = $stmt->fetch();

        return $row === false ? null : $row;
    }

    /** @return array<string,mixed>|null */
    public function findPublish(int $projectId, string $platform): ?array
    {
        $stmt = $this->connection->pdo()->prepare(
            'SELECT * FROM publish_logs WHERE project_id = :project_id AND platform = :platform'
        );
        $stmt->execute(['project_id' => $projectId, 'platform' => $platform]);
        $row = $stmt->fetch();

        return $row === false ? null : $row;
    }

    // ------------------------------------------------------------- queue (jobs)

    public function enqueue(
        int $tenantId,
        int $projectId,
        string $platform,
        int $priority,
        array $payload,
        ?string $dedupeKey,
        \DateTimeImmutable $now,
    ): int {
        $stmt = $this->connection->pdo()->prepare(
            "INSERT INTO render_jobs
                (tenant_id, project_id, platform, state, priority, payload, available_at, dedupe_key, created_at, updated_at)
             VALUES (:tenant_id, :project, :platform, 'waiting', :priority, :payload, :available, :dedupe, :now_created, :now_updated)
             ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)"
        );
        $stmt->execute([
            'tenant_id' => $tenantId,
            'project' => $projectId,
            'platform' => $platform,
            'priority' => max(0, min(9, $priority)),
            'payload' => json_encode($payload, JSON_UNESCAPED_UNICODE),
            'available' => $now->format('Y-m-d H:i:s.v'),
            'dedupe' => $dedupeKey,
            'now_created' => $now->format('Y-m-d H:i:s.v'),
            'now_updated' => $now->format('Y-m-d H:i:s.v'),
        ]);

        return (int) $this->connection->pdo()->lastInsertId();
    }

    public function claimNext(
        string $workerId,
        int $leaseSeconds,
        ?int $tenantId,
        \DateTimeImmutable $now,
    ): ?array {
        return $this->connection->transaction(function (\PDO $pdo) use ($workerId, $leaseSeconds, $tenantId, $now): ?array {
            $sql = "SELECT * FROM render_jobs
                    WHERE state IN ('waiting','delayed') AND available_at <= :now";
            $params = ['now' => $now->format('Y-m-d H:i:s.v')];
            if ($tenantId !== null) {
                $sql .= ' AND tenant_id = :tenant_id';
                $params['tenant_id'] = $tenantId;
            }
            // Priority first, then the job that has been due longest, then insertion order.
            // SKIP LOCKED: another worker's claimed row is invisible instead of blocking us.
            $sql .= ' ORDER BY priority DESC, available_at ASC, id ASC LIMIT 1 FOR UPDATE SKIP LOCKED';

            $select = $pdo->prepare($sql);
            $select->execute($params);
            $job = $select->fetch();
            if ($job === false) {
                return null;
            }

            $leaseUntil = (clone $now)->modify("+{$leaseSeconds} seconds");
            $update = $pdo->prepare(
                "UPDATE render_jobs
                 SET state = 'active', attempts = attempts + 1, worker_id = :worker,
                     started_at = COALESCE(started_at, :now_started), lease_expires_at = :lease, updated_at = :now_updated
                 WHERE id = :id"
            );
            $update->execute([
                'worker' => $workerId,
                'now_started' => $now->format('Y-m-d H:i:s.v'),
                'now_updated' => $now->format('Y-m-d H:i:s.v'),
                'lease' => $leaseUntil->format('Y-m-d H:i:s.v'),
                'id' => (int) $job['id'],
            ]);

            $job['state'] = 'active';
            $job['attempts'] = (int) $job['attempts'] + 1;
            $job['worker_id'] = $workerId;
            $job['lease_expires_at'] = $leaseUntil->format('Y-m-d H:i:s.v');

            return $job;
        });
    }

    /** Progress is monotonic: a late "40%" arriving after "80%" must not move the bar back. */
    public function updateProgress(int $jobId, float $progress, \DateTimeImmutable $now): void
    {
        $stmt = $this->connection->pdo()->prepare(
            'UPDATE render_jobs
             SET progress = GREATEST(progress, :progress), updated_at = :now
             WHERE id = :id AND state = \'active\''
        );
        $stmt->execute([
            'progress' => max(0.0, min(100.0, round($progress, 2))),
            'now' => $now->format('Y-m-d H:i:s.v'),
            'id' => $jobId,
        ]);
    }

    public function complete(int $jobId, array $result, string $outputPath, \DateTimeImmutable $now): void
    {
        $this->connection->transaction(function (\PDO $pdo) use ($jobId, $result, $outputPath, $now): void {
            $stmt = $pdo->prepare(
                "UPDATE render_jobs
                 SET state = 'completed', progress = 100.00, result = :result, finished_at = :now_finished,
                     lease_expires_at = NULL, last_error = NULL, updated_at = :now_updated
                 WHERE id = :id"
            );
            $stmt->execute([
                'result' => json_encode($result + ['output_path' => $outputPath], JSON_UNESCAPED_UNICODE),
                'now_finished' => $now->format('Y-m-d H:i:s.v'),
                'now_updated' => $now->format('Y-m-d H:i:s.v'),
                'id' => $jobId,
            ]);

            // The project follows its render job; one project = one active render.
            $pdo->prepare(
                "UPDATE shortform_projects SET status = 'rendered', updated_at = :now_rendered
                 WHERE id = (SELECT project_id FROM render_jobs WHERE id = :id)
                   AND status IN ('scripted','rendering')"
            )->execute(['now_rendered' => $now->format('Y-m-d H:i:s.v'), 'id' => $jobId]);
        });
    }

    /**
     * Failure routing: retryable → delayed with exponential backoff, exhausted → dlq,
     * non-retryable → failed. The distinction is the difference between "the encoder ran
     * out of memory" (retry) and "the codec is unsupported" (do not retry 50 times).
     */
    public function fail(int $jobId, string $error, bool $retryable, \DateTimeImmutable $now): void
    {
        $job = $this->connection->pdo()->prepare('SELECT attempts, max_attempts FROM render_jobs WHERE id = :id');
        $job->execute(['id' => $jobId]);
        $row = $job->fetch();
        if ($row === false) {
            return;
        }

        $attempts = (int) $row['attempts'];
        $maxAttempts = (int) $row['max_attempts'];

        $state = match (true) {
            !$retryable => 'failed',
            $attempts >= $maxAttempts => 'dlq',
            default => 'delayed',
        };
        $delaySeconds = $state === 'delayed' ? min(2 ** $attempts, 300) : 0;
        $availableAt = (clone $now)->modify("+{$delaySeconds} seconds");

        $stmt = $this->connection->pdo()->prepare(
            "UPDATE render_jobs
             SET state = :state, last_error = :error, available_at = :available,
                 lease_expires_at = NULL, worker_id = NULL,
                 finished_at = CASE WHEN :state_check IN ('failed','dlq') THEN :now_finished ELSE finished_at END,
                 updated_at = :now_updated
             WHERE id = :id"
        );
        $stmt->execute([
            'state' => $state,
            'state_check' => $state,
            'error' => mb_substr($error, 0, 2000),
            'available' => $availableAt->format('Y-m-d H:i:s.v'),
            'now_finished' => $now->format('Y-m-d H:i:s.v'),
            'now_updated' => $now->format('Y-m-d H:i:s.v'),
            'id' => $jobId,
        ]);
    }

    public function reclaimStalled(int $limit, \DateTimeImmutable $now): int
    {
        $stmt = $this->connection->pdo()->prepare(
            "UPDATE render_jobs
             SET state = IF(attempts >= max_attempts, 'dlq', 'delayed'),
                 available_at = :now_available, lease_expires_at = NULL, worker_id = NULL,
                 last_error = CONCAT(COALESCE(last_error, ''), ' | stalled: lease expired'),
                 updated_at = :now_updated
             WHERE state = 'active' AND lease_expires_at IS NOT NULL AND lease_expires_at < :now_threshold
             ORDER BY lease_expires_at ASC
             LIMIT :limit_rows"
        );
        $stmt->bindValue(':now_available', $now->format('Y-m-d H:i:s.v'));
        $stmt->bindValue(':now_updated', $now->format('Y-m-d H:i:s.v'));
        $stmt->bindValue(':now_threshold', $now->format('Y-m-d H:i:s.v'));
        $stmt->bindValue(':limit_rows', $limit, \PDO::PARAM_INT);
        $stmt->execute();

        return $stmt->rowCount();
    }

    /** @return array<string,int> */
    public function countsByState(int $tenantId): array
    {
        $stmt = $this->connection->pdo()->prepare(
            'SELECT state, COUNT(*) AS n FROM render_jobs WHERE tenant_id = :tenant_id GROUP BY state'
        );
        $stmt->execute(['tenant_id' => $tenantId]);

        $counts = ['waiting' => 0, 'delayed' => 0, 'active' => 0, 'completed' => 0, 'failed' => 0, 'dlq' => 0];
        foreach ($stmt->fetchAll() as $row) {
            $counts[(string) $row['state']] = (int) $row['n'];
        }

        return $counts;
    }

    // --------------------------------------------------------------- publishing

    public function startPublish(
        int $tenantId,
        int $projectId,
        int $creatorAccountId,
        string $platform,
        string $captionHash,
        array $requestPayload,
        \DateTimeImmutable $now,
    ): int {
        // One publish row per (project, platform): a retry increments attempts on the same
        // row instead of creating a second container record.
        $stmt = $this->connection->pdo()->prepare(
            "INSERT INTO publish_logs
                (tenant_id, project_id, creator_account_id, platform, status, caption_hash,
                 request_payload, attempts, created_at, updated_at)
             VALUES (:tenant_id, :project, :creator, :platform, 'container_created', :caption_hash,
                     :payload, 0, :now_created, :now_updated)
             ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id), attempts = attempts + 1,
                 caption_hash = :caption_touched, request_payload = :payload_touched, updated_at = :now_touched"
        );
        // Native prepares cannot reuse one named placeholder for two positions, so the
        // retry-branch timestamp needs its own name even though the value is identical.
        $stmt->execute([
            'tenant_id' => $tenantId,
            'project' => $projectId,
            'creator' => $creatorAccountId,
            'platform' => $platform,
            'caption_hash' => $captionHash,
            'payload' => json_encode($requestPayload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES),
            'now_created' => $now->format('Y-m-d H:i:s.v'),
            'now_updated' => $now->format('Y-m-d H:i:s.v'),
            'now_touched' => $now->format('Y-m-d H:i:s.v'),
            'caption_touched' => $captionHash,
            'payload_touched' => json_encode($requestPayload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES),
        ]);

        return (int) $this->connection->pdo()->lastInsertId();
    }

    public function markContainer(int $publishId, string $containerId, \DateTimeImmutable $now): void
    {
        $stmt = $this->connection->pdo()->prepare(
            "UPDATE publish_logs
             SET container_id = :container, status = 'in_progress', last_polled_at = :now_polled, updated_at = :now_updated
             WHERE id = :id"
        );
        $stmt->execute([
            'container' => $containerId,
            'now_polled' => $now->format('Y-m-d H:i:s.v'),
            'now_updated' => $now->format('Y-m-d H:i:s.v'),
            'id' => $publishId,
        ]);
    }

    public function markPublished(
        int $publishId,
        int $projectId,
        string $mediaId,
        ?string $permalink,
        int $quotaUsed,
        int $quotaTotal,
        \DateTimeImmutable $now,
    ): void {
        $this->connection->transaction(function (\PDO $pdo) use ($publishId, $projectId, $mediaId, $permalink, $quotaUsed, $quotaTotal, $now): void {
            $stmt = $pdo->prepare(
                "UPDATE publish_logs
                 SET status = 'published', media_id = :media, permalink = :permalink,
                     quota_used = :quota_used, quota_total = :quota_total,
                     published_at = :now_published, updated_at = :now_updated
                 WHERE id = :id"
            );
            $stmt->execute([
                'media' => $mediaId,
                'permalink' => $permalink,
                'quota_used' => $quotaUsed,
                'quota_total' => $quotaTotal,
                'now_published' => $now->format('Y-m-d H:i:s.v'),
                'now_updated' => $now->format('Y-m-d H:i:s.v'),
                'id' => $publishId,
            ]);

            $pdo->prepare(
                "UPDATE shortform_projects SET status = 'published', published_at = COALESCE(published_at, :now_published), updated_at = :now_updated
                 WHERE id = :project"
            )->execute([
                'now_published' => $now->format('Y-m-d H:i:s.v'),
                'now_updated' => $now->format('Y-m-d H:i:s.v'),
                'project' => $projectId,
            ]);
        });
    }

    public function markFailed(int $publishId, ?int $errorCode, string $message, \DateTimeImmutable $now): void
    {
        $stmt = $this->connection->pdo()->prepare(
            "UPDATE publish_logs
             SET status = 'failed', error_code = :code, error_message = :message, updated_at = :now_updated
             WHERE id = :id"
        );
        $stmt->execute([
            'code' => $errorCode,
            'message' => mb_substr($message, 0, 500),
            'now_updated' => $now->format('Y-m-d H:i:s.v'),
            'id' => $publishId,
        ]);
    }

    public function applyWebhookEvent(
        string $mediaId,
        string $eventId,
        string $status,
        array $rawEvent,
        \DateTimeImmutable $now,
    ): WebhookApplyResult {
        $stmt = $this->connection->pdo()->prepare(
            'UPDATE publish_logs
             SET status = :status, permalink = COALESCE(NULLIF(:permalink, \'\'), permalink),
                 last_event_id = :event, response_payload = :raw, updated_at = :now_updated
             WHERE media_id = :media_id AND (last_event_id IS NULL OR last_event_id <> :event_check)'
        );
        $stmt->execute([
            'status' => $status,
            'permalink' => $rawEvent['permalink'] ?? '',
            'event' => $eventId,
            'event_check' => $eventId,
            'raw' => json_encode($rawEvent, JSON_UNESCAPED_UNICODE),
            'now_updated' => $now->format('Y-m-d H:i:s.v'),
            'media_id' => $mediaId,
        ]);

        if ($stmt->rowCount() > 0) {
            return WebhookApplyResult::Applied;
        }

        // 0 rows means either "same event again" or "we have no such media".
        // Those lead to different operator actions, so ask the table which one it is.
        $exists = $this->connection->pdo()->prepare('SELECT 1 FROM publish_logs WHERE media_id = :media_id LIMIT 1');
        $exists->execute(['media_id' => $mediaId]);

        return $exists->fetchColumn() === false ? WebhookApplyResult::Unknown : WebhookApplyResult::Duplicate;
    }

    /** @return array<string,int> */
    public function publishStats(int $tenantId): array
    {
        $stmt = $this->connection->pdo()->prepare(
            'SELECT status, COUNT(*) AS n FROM publish_logs WHERE tenant_id = :tenant_id GROUP BY status'
        );
        $stmt->execute(['tenant_id' => $tenantId]);

        $stats = ['container_created' => 0, 'in_progress' => 0, 'published' => 0, 'failed' => 0, 'expired' => 0];
        foreach ($stmt->fetchAll() as $row) {
            $stats[(string) $row['status']] = (int) $row['n'];
        }

        return $stats;
    }

    // ------------------------------------------------------------- notifications

    public function claim(
        int $tenantId,
        ?int $projectId,
        string $event,
        string $dedupeKey,
        string $templateCode,
        string $plusFriendId,
        string $recipientPhone,
        array $payload,
        \DateTimeImmutable $now,
    ): ?int {
        $masked = RecipientPhone::fromString($recipientPhone)->masked();

        $stmt = $this->connection->pdo()->prepare(
            "INSERT IGNORE INTO alimtalk_notifications
                (tenant_id, project_id, event, template_code, plus_friend_id, recipient_phone,
                 dedupe_key, status, request_payload, created_at)
             VALUES (:tenant_id, :project, :event, :template, :channel, :phone, :dedupe, 'queued', :payload, :now)"
        );
        $stmt->execute([
            'tenant_id' => $tenantId,
            'project' => $projectId,
            'event' => $event,
            'template' => $templateCode,
            'channel' => $plusFriendId,
            'phone' => $masked,
            'dedupe' => $dedupeKey,
            'payload' => json_encode($payload, JSON_UNESCAPED_UNICODE),
            'now' => $now->format('Y-m-d H:i:s.v'),
        ]);

        if ($stmt->rowCount() === 0) {
            return null;
        }

        return (int) $this->connection->pdo()->lastInsertId();
    }

    public function markAccepted(int $id, AlimtalkSendResult $result, AlimtalkMessage $message, \DateTimeImmutable $now): void
    {
        $stmt = $this->connection->pdo()->prepare(
            "UPDATE alimtalk_notifications
             SET status = 'accepted', request_id = :request, sent_at = :now_sent, attempts = attempts + 1,
                 request_payload = :payload, response_payload = :response, error_message = NULL
             WHERE id = :id"
        );
        $stmt->execute([
            'request' => $result->requestId,
            'now_sent' => $now->format('Y-m-d H:i:s.v'),
            'payload' => json_encode($message->toAuditArray(), JSON_UNESCAPED_UNICODE),
            'response' => json_encode($result->raw, JSON_UNESCAPED_UNICODE),
            'id' => $id,
        ]);
    }

    public function markNotificationFailed(int $id, string $error, \DateTimeImmutable $now): void
    {
        $stmt = $this->connection->pdo()->prepare(
            "UPDATE alimtalk_notifications
             SET status = 'failed', attempts = attempts + 1, error_message = :error, updated_at = :now_updated
             WHERE id = :id"
        );
        $stmt->execute([
            'error' => mb_substr($error, 0, 500),
            'now_updated' => $now->format('Y-m-d H:i:s.v'),
            'id' => $id,
        ]);
    }
}
