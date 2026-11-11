<?php

declare(strict_types=1);

namespace Shortform\Services;

use Shortform\Support\Clock;
use Shortform\Support\HttpClient;
use Shortform\Support\HttpRequest;
use Shortform\Support\Sleeper;

/**
 * Instagram Content Publishing via Meta Graph API.
 *
 * The protocol is three steps and the middle one is mandatory:
 *
 *   POST /{ig-user-id}/media           media_type=REELS, video_url, caption
 *   GET  /{container-id}?fields=status_code,status   poll until FINISHED
 *   POST /{ig-user-id}/media_publish   creation_id={container}
 *
 * Publishing before FINISHED returns a generic error and burns one of the 25 daily
 * publishing slots, which is the expensive way to learn that the video was still being
 * transcoded. The poller therefore backs off (2s → ×1.35 → 8s cap) inside a timeout.
 *
 * Everything is injectable (HTTP client, clock, sleeper) so tests assert on the exact
 * requests, the poll sequence and the retry decisions without touching the network.
 */
final class InstagramGraphApiService
{
    public const CAPTION_MAX_CHARS = 2200;
    public const HASHTAG_MAX_COUNT = 30;

    public function __construct(
        private readonly HttpClient $http,
        private readonly InstagramConfig $config,
        private readonly Clock $clock,
        private readonly Sleeper $sleeper,
    ) {
    }

    /** Merge hashtags into the caption without duplicating ones already typed. */
    public static function buildCaption(string $caption, array $hashtags): string
    {
        $existing = [];
        if (preg_match_all('/#[^\s#]+/u', $caption, $matches) > 0) {
            $existing = array_map(static fn (string $tag): string => mb_strtolower($tag), $matches[0]);
        }

        $missing = [];
        foreach ($hashtags as $tag) {
            $normalized = str_starts_with($tag, '#') ? $tag : '#' . $tag;
            if (!in_array(mb_strtolower($normalized), $existing, true) && !in_array($normalized, $missing, true)) {
                $missing[] = $normalized;
            }
        }

        $merged = trim($caption) . ($missing === [] ? '' : "\n\n" . implode(' ', $missing));

        return mb_substr($merged, 0, self::CAPTION_MAX_CHARS);
    }

    /** Local validation before spending a rate-limit slot: returns an error or null. */
    public static function captionError(string $caption): ?string
    {
        if (mb_strlen($caption) > self::CAPTION_MAX_CHARS) {
            return sprintf('caption is %d chars, Instagram allows %d', mb_strlen($caption), self::CAPTION_MAX_CHARS);
        }
        $tagCount = preg_match_all('/#[^\s#]+/u', $caption);
        if ($tagCount !== false && $tagCount > self::HASHTAG_MAX_COUNT) {
            return sprintf('%d hashtags, Instagram allows %d', $tagCount, self::HASHTAG_MAX_COUNT);
        }

        return null;
    }

    public function createReelContainer(ReelInput $input): string
    {
        $captionError = self::captionError($input->caption);
        if ($captionError !== null) {
            throw new \InvalidArgumentException($captionError);
        }
        if (preg_match('#^https://#i', $input->videoUrl) !== 1) {
            throw new \InvalidArgumentException('Instagram requires a public https video URL (S3/R2/CDN).');
        }

        $form = [
            'media_type' => 'REELS',
            'video_url' => $input->videoUrl,
            'caption' => $input->caption,
            'share_to_feed' => $input->shareToFeed ? 'true' : 'false',
        ];
        if ($input->coverUrl !== null) {
            $form['cover_url'] = $input->coverUrl;
        }
        if ($input->thumbOffsetMs !== null) {
            $form['thumb_offset'] = (string) $input->thumbOffsetMs;
        }
        if ($input->scheduleAt !== null) {
            // Graph API accepts scheduled publishing between 10 minutes and 75 days ahead.
            $form['published'] = 'false';
            $form['scheduled_publish_time'] = (string) $input->scheduleAt->getTimestamp();
        }

        $response = $this->call('POST', "/{$this->config->igUserId}/media", $form);
        $containerId = (string) ($response['id'] ?? '');
        if ($containerId === '') {
            throw new InstagramApiException('Graph API did not return a container id', httpStatus: 200);
        }

        return $containerId;
    }

    /** @return array{statusCode:string, status:string} */
    public function getContainerStatus(string $containerId): array
    {
        $response = $this->call('GET', "/{$containerId}", ['fields' => 'status_code,status']);

        return [
            'statusCode' => (string) ($response['status_code'] ?? ''),
            'status' => (string) ($response['status'] ?? ''),
        ];
    }

    /** Poll until FINISHED; throw on ERROR/EXPIRED or when the timeout budget runs out. */
    public function waitForContainer(string $containerId): void
    {
        $startedAt = microtime(true) * 1000;
        $interval = max(200, $this->config->pollIntervalMs);

        while (true) {
            $status = $this->getContainerStatus($containerId);

            if ($status['statusCode'] === 'FINISHED') {
                return;
            }
            if (in_array($status['statusCode'], ['ERROR', 'EXPIRED'], true)) {
                throw new InstagramApiException(
                    "Container {$containerId} ended in {$status['statusCode']}: {$status['status']}",
                    httpStatus: 200,
                    retryable: false,
                    hint: 'The uploaded video was rejected by Meta (codec/aspect/bitrate). Re-render and retry.',
                );
            }

            if ((microtime(true) * 1000) - $startedAt > $this->config->pollTimeoutMs) {
                throw new InstagramApiException(
                    "Container {$containerId} did not finish within {$this->config->pollTimeoutMs}ms",
                    httpStatus: 200,
                    retryable: true,
                    hint: 'Container may still be processing; keep it (24h TTL) and poll again instead of re-uploading.',
                );
            }

            $this->sleeper->sleepMilliseconds($interval);
            $interval = (int) min($interval * 1.35, 8_000);
        }
    }

    public function publishContainer(string $containerId): string
    {
        $response = $this->call('POST', "/{$this->config->igUserId}/media_publish", [
            'creation_id' => $containerId,
        ]);
        $mediaId = (string) ($response['id'] ?? '');
        if ($mediaId === '') {
            throw new InstagramApiException('Graph API did not return a media id', httpStatus: 200);
        }

        return $mediaId;
    }

    public function getPermalink(string $mediaId): ?string
    {
        $response = $this->call('GET', "/{$mediaId}", ['fields' => 'permalink']);

        return isset($response['permalink']) ? (string) $response['permalink'] : null;
    }

    /** @return array{usage:int, total:int} */
    public function getPublishingQuota(): array
    {
        $response = $this->call('GET', "/{$this->config->igUserId}/content_publishing_limit", [
            'fields' => 'quota_usage,config',
        ]);
        $entry = $response['data'][0] ?? [];

        return [
            'usage' => (int) ($entry['quota_usage'] ?? 0),
            'total' => (int) ($entry['config']['quota_total'] ?? 25),
        ];
    }

    /**
     * Long-lived token refresh.
     *
     * Two flows exist because two token families do:
     *  - Facebook Login tokens: GET /oauth/access_token?grant_type=fb_exchange_token
     *  - Instagram API with Instagram Login tokens: GET graph.instagram.com/refresh_access_token
     *    ?grant_type=ig_refresh_token
     * Using the wrong one returns a token that works locally and fails at publish time.
     *
     * @return array{accessToken:string, expiresInSec:int}
     */
    public function refreshToken(string $token, TokenFlow $flow): array
    {
        if ($flow === TokenFlow::InstagramRefresh) {
            $url = 'https://graph.instagram.com/refresh_access_token?' . http_build_query([
                'grant_type' => 'ig_refresh_token',
                'access_token' => $token,
            ]);
            $response = $this->rawGet($url);

            return [
                'accessToken' => (string) ($response['access_token'] ?? ''),
                'expiresInSec' => (int) ($response['expires_in'] ?? 0),
            ];
        }

        $url = $this->config->graphBase() . '/oauth/access_token?' . http_build_query([
            'grant_type' => 'fb_exchange_token',
            'client_id' => $this->config->igUserId,
            'client_secret' => '',
            'fb_exchange_token' => $token,
        ]);

        $response = $this->rawGet($url);

        return [
            'accessToken' => (string) ($response['access_token'] ?? ''),
            'expiresInSec' => (int) ($response['expires_in'] ?? 0),
        ];
    }

    /**
     * Single request with bounded retries for genuinely transient failures.
     *
     * Retry rules matter more than they look: publishing is quota-limited, so retrying a
     * 190 (expired token) or a 100 (bad parameter) just burns attempts. Only rate limits
     * (4/17/32/613), "container still processing" (9007) and 5xx are retried.
     *
     * @param array<string,string> $form
     * @return array<string,mixed>
     */
    private function call(string $method, string $path, array $form = []): array
    {
        $attempt = 0;
        while (true) {
            $attempt++;

            $url = $this->config->graphBase() . $path;
            $body = null;
            $headers = [];

            if ($method === 'GET') {
                $form['access_token'] = $this->config->accessToken;
                $url .= '?' . http_build_query($form);
            } else {
                $form['access_token'] = $this->config->accessToken;
                $body = http_build_query($form);
                $headers['Content-Type'] = 'application/x-www-form-urlencoded';
            }

            $response = $this->http->send(new HttpRequest($method, $url, $headers, $body));

            if ($response->isSuccess()) {
                return $response->json();
            }

            $payload = json_decode($response->body, true);
            $error = is_array($payload) && isset($payload['error']) && is_array($payload['error'])
                ? $payload['error']
                : ['code' => 0, 'message' => mb_substr($response->body, 0, 300)];

            $exception = InstagramApiException::fromMetaError($error, $response->status);

            if (!$exception->retryable || $attempt >= $this->config->maxRetries) {
                throw $exception;
            }

            $this->sleeper->sleepMilliseconds(700 * (2 ** ($attempt - 1)));
        }
    }

    /** @return array<string,mixed> */
    private function rawGet(string $url): array
    {
        $response = $this->http->send(new HttpRequest('GET', $url));
        if (!$response->isSuccess()) {
            $payload = json_decode($response->body, true);
            $error = is_array($payload) && isset($payload['error']) && is_array($payload['error'])
                ? $payload['error']
                : ['code' => 0, 'message' => mb_substr($response->body, 0, 300)];
            throw InstagramApiException::fromMetaError($error, $response->status);
        }

        return $response->json();
    }
}
