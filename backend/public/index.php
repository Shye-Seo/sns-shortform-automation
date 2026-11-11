<?php

declare(strict_types=1);

/**
 * HTTP entry point.
 *
 *   php -S 127.0.0.1:8081 -t backend/public
 *
 * Routes
 *   GET  /health                              liveness + which integrations are configured
 *   GET  /webhooks/instagram                  Meta verification (returns the raw challenge)
 *   POST /webhooks/instagram                  Meta events (X-Hub-Signature-256 verified)
 *   GET  /api/v1/tenants/{tenant_id}/queue    queue counts per state
 *   GET  /api/v1/tenants/{tenant_id}/publish  publish stats per status
 *   POST /api/v1/projects/{project_id}/publish  orchestrated publish (container → publish)
 */

require __DIR__ . '/../vendor/autoload.php';

use Shortform\Controllers\PublishWebhookController;
use Shortform\Database\Connection;
use Shortform\Domain\Platform;
use Shortform\Http\BadRequestException;
use Shortform\Http\JsonResponse;
use Shortform\Http\Request;
use Shortform\Http\Router;
use Shortform\Http\WebhookRejected;
use Shortform\Repositories\ShortformRepository;
use Shortform\Sens\SensConfig;
use Shortform\Services\DisabledAlertNotifier;
use Shortform\Services\InstagramConfig;
use Shortform\Services\InstagramGraphApiService;
use Shortform\Services\NaverCloudSensService;
use Shortform\Services\PublishJob;
use Shortform\Services\PublishOrchestrator;
use Shortform\Services\ShortformAlertComposer;
use Shortform\Services\ShortformAlertNotifier;
use Shortform\Support\CurlHttpClient;
use Shortform\Support\Env;
use Shortform\Support\SystemClock;
use Shortform\Support\SystemSleeper;

Env::load(__DIR__ . '/../.env');

$debug = Env::bool('APP_DEBUG', false);

try {
    $clock = new SystemClock(Env::get('DB_TIMEZONE', '+09:00') ?? '+09:00');
    $http = new CurlHttpClient();
    $connection = Connection::fromEnv();
    $repository = new ShortformRepository($connection);

    $sensConfigured = Env::get('SENS_ACCESS_KEY') !== null
        && Env::get('SENS_SECRET_KEY') !== null
        && Env::get('SENS_SERVICE_ID') !== null;

    $sensConfig = $sensConfigured
        ? new SensConfig(
            accessKey: Env::required('SENS_ACCESS_KEY'),
            secretKey: Env::required('SENS_SECRET_KEY'),
            serviceId: Env::required('SENS_SERVICE_ID'),
            plusFriendId: Env::get('SENS_PLUS_FRIEND_ID', '@shortform') ?? '@shortform',
            templateCodes: SensConfig::defaultTemplateCodes(),
            failoverFrom: Env::get('SENS_FAILOVER_FROM'),
        )
        : null;

    $notifier = $sensConfig !== null
        ? new ShortformAlertNotifier(
            new NaverCloudSensService($http, $sensConfig, $clock),
            $repository,
            new ShortformAlertComposer(),
            $sensConfig,
            $clock,
        )
        : new DisabledAlertNotifier();

    $webhook = new PublishWebhookController(
        $repository,
        Env::get('IG_VERIFY_TOKEN', '') ?? '',
        Env::get('IG_APP_SECRET', '') ?? '',
        $clock,
    );

    $router = new Router();
    $router->get('/health', static fn (): array => [
        'status' => 'ok',
        'service' => 'shortform-backend',
        'time' => $clock->now()->format(\DateTimeInterface::ATOM),
        'integrations' => [
            'alimtalk' => $sensConfigured ? 'enabled' : 'disabled(no SENS credentials)',
            'instagram' => Env::get('IG_ACCESS_TOKEN') !== null ? 'enabled' : 'disabled(no IG token)',
        ],
    ]);
    $router->get('/webhooks/instagram', static fn (Request $r): string => $webhook->verify($r));
    $router->post('/webhooks/instagram', static fn (Request $r): array => $webhook->receive($r));
    $router->get('/api/v1/tenants/{tenant_id}/queue', static fn (Request $r, array $p): array => [
        'tenant_id' => (int) $p['tenant_id'],
        'counts' => $repository->countsByState((int) $p['tenant_id']),
    ]);
    $router->get('/api/v1/tenants/{tenant_id}/publish', static fn (Request $r, array $p): array => [
        'tenant_id' => (int) $p['tenant_id'],
        'stats' => $repository->publishStats((int) $p['tenant_id']),
    ]);
    $router->post('/api/v1/projects/{project_id}/publish', static function (Request $r, array $p) use ($repository, $notifier, $http, $clock): array {
        $project = $repository->findProject((int) $p['project_id']);
        if ($project === null) {
            throw new BadRequestException('Project not found.', ['project_id' => $p['project_id']]);
        }
        $account = $repository->findCreatorAccount((int) $project['creator_account_id']);
        if ($account === null) {
            throw new BadRequestException('Creator account not found for this project.');
        }

        // Graph credentials are resolved here, not at boot: without them the queue and
        // webhook routes must still work (development, CI, and before app review).
        $igUserId = Env::get('IG_BUSINESS_ACCOUNT_ID', '') ?? '';
        $igToken = Env::get('IG_ACCESS_TOKEN', '') ?? '';
        if ($igUserId === '' || $igToken === '') {
            throw new BadRequestException('Instagram publishing is not configured (IG_BUSINESS_ACCOUNT_ID / IG_ACCESS_TOKEN).');
        }

        $orchestrator = new PublishOrchestrator(
            new InstagramGraphApiService(
                $http,
                new InstagramConfig(
                    igUserId: $igUserId,
                    accessToken: $igToken,
                    apiVersion: Env::get('IG_GRAPH_VERSION', 'v21.0') ?? 'v21.0',
                ),
                $clock,
                new SystemSleeper(),
            ),
            $repository,
            $notifier,
            $clock,
        );

        $videoUrl = (string) ($r->json['video_url'] ?? '');
        if ($videoUrl === '') {
            throw new BadRequestException('video_url is required (public HTTPS URL of the rendered file).');
        }

        $job = new PublishJob(
            tenantId: (int) $project['tenant_id'],
            projectId: (int) $project['id'],
            creatorAccountId: (int) $project['creator_account_id'],
            platform: Platform::from((string) ($project['platform'] ?? 'instagram-reels')),
            videoUrl: $videoUrl,
            caption: (string) $project['caption'],
            hashtags: json_decode((string) $project['hashtags'], true) ?: [],
            projectTitle: (string) $project['title'],
            recipientPhone: (string) ($r->json['recipient_phone'] ?? ''),
            // Approval hash is produced by the script engine over narration+caption+cues.
            // Without that shared hash we must not claim content is approved, so the check
            // is left off here and enforced in the worker that has the full script.
            approvedContentHash: null,
            currentContentHash: null,
        );

        return ['project_id' => (int) $project['id'], 'outcome' => $orchestrator->publish($job)->toArray()];
    });

    $request = Request::fromGlobals();
    $match = $router->match($request->method, $request->path);

    if ($match === null) {
        JsonResponse::error('not_found', "No route for {$request->method} {$request->path}", 404);
        exit;
    }

    $payload = ($match['handler'])($request, $match['params']);
    if (is_string($payload)) {
        // Meta verification expects the raw challenge, not JSON.
        header('Content-Type: text/plain; charset=utf-8');
        echo $payload;
        exit;
    }

    JsonResponse::send($payload, 200);
} catch (WebhookRejected $e) {
    JsonResponse::error('webhook_rejected', $e->getMessage(), 403);
} catch (BadRequestException $e) {
    JsonResponse::error('invalid_request', $e->getMessage(), 400, $e->details());
} catch (\InvalidArgumentException $e) {
    JsonResponse::error('invalid_request', $e->getMessage(), 400);
} catch (\Throwable $e) {
    error_log(sprintf('[shortform] %s: %s in %s:%d', get_class($e), $e->getMessage(), $e->getFile(), $e->getLine()));
    JsonResponse::error('internal_error', $debug ? $e->getMessage() : 'Internal server error', 500);
}
