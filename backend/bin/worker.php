#!/usr/bin/env php
<?php

declare(strict_types=1);

/**
 * Render-queue worker (demo / integration harness).
 *
 *   php backend/bin/worker.php --once --phone=01012345678
 *   php backend/bin/worker.php --jobs=3 --tenant=1
 *
 * What is real here: claiming (FOR UPDATE SKIP LOCKED), lease handling, progress
 * monotonicity, retry/DLQ routing, stalled-job recovery and the completion notification.
 * What is simulated: the encode itself. The production encoder is the TypeScript pipeline
 * in src/ (ffmpeg, chunked render); it claims the same rows with the same SQL, because the
 * queue is the contract between the two runtimes, not a PHP-only detail.
 *
 * Options:
 *   --once              claim at most one job
 *   --jobs=N            stop after N jobs (default 1)
 *   --tenant=ID         only claim jobs of one tenant
 *   --phone=010…        send the render-completed alimtalk
 *   --worker-id=NAME    lease owner name (default host:pid)
 *   --fail              simulate a failure (to exercise retry/DLQ routing)
 */

require __DIR__ . '/../vendor/autoload.php';

use Shortform\Database\Connection;
use Shortform\Repositories\ShortformRepository;
use Shortform\Sens\SensConfig;
use Shortform\Services\DisabledAlertNotifier;
use Shortform\Services\NaverCloudSensService;
use Shortform\Services\ShortformAlertComposer;
use Shortform\Services\ShortformAlertNotifier;
use Shortform\Support\CurlHttpClient;
use Shortform\Support\Env;
use Shortform\Support\SystemClock;

Env::load(__DIR__ . '/../.env');

$options = getopt('', ['once', 'jobs::', 'tenant::', 'phone::', 'worker-id::', 'fail', 'help']);

if (isset($options['help'])) {
    fwrite(STDOUT, "usage: php backend/bin/worker.php [--once] [--jobs=N] [--tenant=ID] [--phone=010…] [--fail]\n");
    exit(0);
}

$clock = new SystemClock(Env::get('DB_TIMEZONE', '+09:00') ?? '+09:00');
$connection = Connection::fromEnv();
$repository = new ShortformRepository($connection);

$maxJobs = isset($options['once']) ? 1 : (int) ($options['jobs'] ?? 1);
$tenantId = isset($options['tenant']) ? (int) $options['tenant'] : null;
$workerId = (string) ($options['worker-id'] ?? (gethostname() . ':' . getmypid()));
$leaseSeconds = Env::int('WORKER_LEASE_SECONDS', 300);
$simulateFailure = isset($options['fail']);

$notifier = new DisabledAlertNotifier();
$phone = isset($options['phone']) ? (string) $options['phone'] : null;
if ($phone !== null) {
    $sensConfig = new SensConfig(
        accessKey: Env::required('SENS_ACCESS_KEY'),
        secretKey: Env::required('SENS_SECRET_KEY'),
        serviceId: Env::required('SENS_SERVICE_ID'),
        plusFriendId: Env::get('SENS_PLUS_FRIEND_ID', '@shortform') ?? '@shortform',
        templateCodes: SensConfig::defaultTemplateCodes(),
        failoverFrom: Env::get('SENS_FAILOVER_FROM'),
    );
    $notifier = new ShortformAlertNotifier(
        new NaverCloudSensService(new CurlHttpClient(), $sensConfig, $clock),
        $repository,
        new ShortformAlertComposer(),
        $sensConfig,
        $clock,
    );
}

// Recover jobs whose worker died mid-encode before claiming new work.
$reclaimed = $repository->reclaimStalled(50, $clock->now());
if ($reclaimed > 0) {
    fwrite(STDOUT, "reclaimed stalled jobs: {$reclaimed}\n");
}

for ($processed = 0; $processed < $maxJobs; $processed++) {
    $job = $repository->claimNext($workerId, $leaseSeconds, $tenantId, $clock->now());
    if ($job === null) {
        fwrite(STDOUT, "queue empty.\n");
        break;
    }

    $jobId = (int) $job['id'];
    $payload = json_decode((string) $job['payload'], true) ?: [];
    $durationSec = (float) ($payload['durationSec'] ?? 30.0);

    fwrite(STDOUT, sprintf(
        "claimed job #%d (tenant %d, attempt %d/%d, priority %d, %.1fs)\n",
        $jobId,
        (int) $job['tenant_id'],
        (int) $job['attempts'],
        (int) $job['max_attempts'],
        (int) $job['priority'],
        $durationSec,
    ));

    if ($simulateFailure) {
        // Retryable failure: the queue puts it back to `delayed` with backoff, or to `dlq`
        // once attempts reach max_attempts. Nothing here decides that — the row does.
        $repository->fail($jobId, 'simulated encoder OOM', true, $clock->now());
        fwrite(STDOUT, "job #{$jobId} failed (retryable) → queue applied backoff\n");
        continue;
    }

    // Progress must be monotonic; updateProgress uses GREATEST() so a late 30% after 70%
    // cannot move the bar backwards.
    foreach ([15.0, 55.0, 90.0] as $step) {
        $repository->updateProgress($jobId, $step, $clock->now());
    }

    $result = [
        'projectId' => (int) $job['project_id'],
        'chunks' => (int) ($payload['chunkCount'] ?? 4),
        'encodedSec' => $durationSec,
        'simulated' => true,
        'worker' => $workerId,
    ];
    $outputPath = (string) ($payload['outputPath'] ?? sprintf('/renders/job-%d.mp4', $jobId));
    $repository->complete($jobId, $result, $outputPath, $clock->now());

    fwrite(STDOUT, sprintf("job #%d completed → %s\n", $jobId, $outputPath));

    if ($notifier !== null && $phone !== null) {
        $sent = $notifier->notifyRenderCompleted(
            tenantId: (int) $job['tenant_id'],
            tenantName: (string) ($payload['tenantName'] ?? 'shortform'),
            projectId: (int) $job['project_id'],
            projectTitle: (string) ($payload['projectTitle'] ?? "project #{$job['project_id']}"),
            durationSec: $durationSec,
            platformLabel: (string) $job['platform'],
            recipientPhone: $phone,
        );
        fwrite(STDOUT, $sent ? "alimtalk sent: render_completed\n" : "alimtalk skipped (already sent or failed)\n");
    }
}

$counts = $repository->countsByState($tenantId ?? (int) ($job['tenant_id'] ?? 1));
fwrite(STDOUT, 'queue: ' . json_encode($counts, JSON_UNESCAPED_UNICODE) . "\n");
