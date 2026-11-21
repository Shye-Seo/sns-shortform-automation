#!/usr/bin/env php
<?php

declare(strict_types=1);

/**
 * Comment → DM coupon worker.
 *
 *   php backend/bin/coupon-worker.php --once
 *   php backend/bin/coupon-worker.php --loop --sleep-ms=200
 *   php backend/bin/coupon-worker.php --once --limit=100 --dry-run-check
 *
 * What one cycle does
 *   1. claim due rows from dispatch_queue (FOR UPDATE SKIP LOCKED, lease re-claim)
 *   2. drop rows that are already past the 5 second deadline into DEAD_LETTER
 *   3. mint a one-time HMAC token per job and attach it to the queue row
 *   4. send through the configured transport (dry-run by default)
 *   5. write the attempt to dispatch_attempts, then DISPATCHED / RETRY / DEAD_LETTER
 *
 * Exit codes: 0 = cycle ran (even if every send failed — those are rows, not process
 * failures), 1 = configuration or database error.
 */

require __DIR__ . '/../vendor/autoload.php';

use Shortform\Bootstrap\CouponServices;
use Shortform\Database\Connection;
use Shortform\Support\CurlHttpClient;
use Shortform\Support\Env;
use Shortform\Support\SystemClock;

Env::load(__DIR__ . '/../.env');

$options = getopt('', ['once', 'loop', 'limit::', 'sleep-ms::', 'max-cycles::', 'worker-id::', 'campaign::', 'help']);

if (isset($options['help'])) {
    fwrite(STDOUT, "usage: php backend/bin/coupon-worker.php [--once|--loop] [--limit=50] [--sleep-ms=200] [--max-cycles=N] [--worker-id=NAME] [--campaign=ID]\n");
    exit(0);
}

$limit = max(1, min(500, (int) ($options['limit'] ?? 50)));
$sleepMs = max(0, (int) ($options['sleep-ms'] ?? 200));
$maxCycles = isset($options['max-cycles']) ? max(1, (int) $options['max-cycles']) : null;
$workerId = (string) ($options['worker-id'] ?? (gethostname() . ':' . getmypid()));
$campaignId = isset($options['campaign']) ? (int) $options['campaign'] : null;
$loop = isset($options['loop']);

try {
    $clock = new SystemClock(Env::get('DB_TIMEZONE', '+09:00') ?? '+09:00');
    $connection = Connection::fromEnv();
    $http = new CurlHttpClient();
    $coupon = CouponServices::fromEnv($connection, $clock, $http);
} catch (\Throwable $e) {
    fwrite(STDERR, 'coupon-worker: ' . $e->getMessage() . "\n");
    exit(1);
}

$sender = Env::get('COUPON_SENDER', 'dryrun') ?? 'dryrun';
fwrite(STDOUT, sprintf(
    "coupon-worker %s · sender=%s · sla=%ds · max-attempts=%d\n",
    $workerId,
    $sender,
    Env::int('COUPON_SLA_SECONDS', 5),
    Env::int('COUPON_MAX_ATTEMPTS', 5),
));

$cycles = 0;
do {
    $cycles++;
    $startedAt = microtime(true);

    try {
        $report = $coupon->dispatcher->dispatchPending($limit, $workerId, $campaignId);
    } catch (\Throwable $e) {
        fwrite(STDERR, 'coupon-worker: cycle failed: ' . $e->getMessage() . "\n");
        exit(1);
    }

    $counts = $report->counts + ['dispatched' => 0, 'retried' => 0, 'deadLettered' => 0, 'late' => 0, 'recovered' => 0];
    $worked = $counts['dispatched'] + $counts['retried'] + $counts['deadLettered'] + $counts['recovered'];

    fwrite(STDOUT, sprintf(
        "[%s] sent=%d retry=%d dlq=%d late=%d recovered=%d worst=%.0fms (%.0fms)\n",
        $clock->now()->format('H:i:s'),
        $counts['dispatched'],
        $counts['retried'],
        $counts['deadLettered'],
        $counts['late'],
        $counts['recovered'],
        $report->worstLatencyMs,
        (microtime(true) - $startedAt) * 1000,
    ));

    if (! $loop) {
        break;
    }

    if ($worked === 0 && $sleepMs > 0) {
        usleep($sleepMs * 1000);
    }

    if ($maxCycles !== null && $cycles >= $maxCycles) {
        break;
    }
} while (true);

exit(0);
