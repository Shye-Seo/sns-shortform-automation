<?php

declare(strict_types=1);

namespace Shortform\Services;

use Shortform\Sens\AlimtalkDeliveryResult;
use Shortform\Sens\AlimtalkEvent;
use Shortform\Sens\AlimtalkMessage;
use Shortform\Sens\AlimtalkSendResult;
use Shortform\Sens\SensConfig;
use Shortform\Sens\SensException;
use Shortform\Support\Clock;
use Shortform\Support\Env;
use Shortform\Support\HttpClient;
use Shortform\Support\HttpRequest;

/**
 * Naver Cloud Platform SENS — Kakao alimtalk transport.
 *
 * The signature is the whole integration:
 *
 *     method + " " + URI (query included) + "\n" + timestamp(ms) + "\n" + accessKey
 *     → base64(HMAC-SHA256(secretKey, message))
 *
 * Three production traps this class closes, each of which looks like "wrong key" when it
 * happens:
 *   1. The signed URI must include the query string, not just the path.
 *   2. The timestamp used in the signature must be the exact string sent in the header.
 *   3. The service id contains colons (`ncp:kkobizmsg:kr:…:sens`); percent-encoding them
 *      changes the request path and the signature no longer matches.
 *
 * Alimtalk is template-based: content must be the reviewed template with `#{vars}`
 * substituted, otherwise SENS answers 3016 (NoMatchedTemplate).
 */
final class NaverCloudSensService
{
    public const MAX_MESSAGES_PER_REQUEST = 100;

    public function __construct(
        private readonly HttpClient $http,
        private readonly SensConfig $config,
        private readonly Clock $clock,
    ) {
    }

    public static function fromEnv(HttpClient $http, Clock $clock): self
    {
        return new self($http, new SensConfig(
            accessKey: Env::required('SENS_ACCESS_KEY'),
            secretKey: Env::required('SENS_SECRET_KEY'),
            serviceId: Env::required('SENS_SERVICE_ID'),
            plusFriendId: Env::get('SENS_PLUS_FRIEND_ID', '@shortform') ?? '@shortform',
            templateCodes: [
                'render_completed' => Env::get('SENS_TEMPLATE_RENDER_DONE', 'SF_RENDER_DONE') ?? 'SF_RENDER_DONE',
                'publish_completed' => Env::get('SENS_TEMPLATE_PUBLISH_DONE', 'SF_PUBLISH_DONE') ?? 'SF_PUBLISH_DONE',
                'publish_failed' => Env::get('SENS_TEMPLATE_PUBLISH_FAILED', 'SF_PUBLISH_FAILED') ?? 'SF_PUBLISH_FAILED',
                'quota_exhausted' => Env::get('SENS_TEMPLATE_QUOTA_EXHAUSTED', 'SF_QUOTA_EXHAUSTED') ?? 'SF_QUOTA_EXHAUSTED',
            ],
            failoverFrom: Env::get('SENS_FAILOVER_FROM'),
            baseUrl: Env::get('SENS_BASE_URL', 'https://sens.apigw.ntruss.com') ?? 'https://sens.apigw.ntruss.com',
        ), $clock);
    }

    /** Pure function so a fixed vector can pin it (see NaverCloudSensServiceTest). */
    public static function sign(
        string $method,
        string $uriPath,
        string $timestamp,
        string $accessKey,
        string $secretKey,
    ): string {
        $message = strtoupper($method) . ' ' . $uriPath . "\n" . $timestamp . "\n" . $accessKey;

        return base64_encode(hash_hmac('sha256', $message, $secretKey, true));
    }

    public function signatureFor(string $method, string $uriPath, string $timestamp): string
    {
        return self::sign($method, $uriPath, $timestamp, $this->config->accessKey, $this->config->secretKey);
    }

    /** Send one notification for an event (template resolved from the event). */
    public function sendForEvent(AlimtalkEvent $event, string $to, string $content): AlimtalkSendResult
    {
        return $this->send(new AlimtalkMessage(
            to: $to,
            content: $content,
            templateCode: $this->config->templateFor($event),
            plusFriendId: $this->config->plusFriendId,
            failoverFrom: $this->config->failoverFrom,
            useSmsFailover: $this->config->failoverFrom !== null,
        ));
    }

    public function send(AlimtalkMessage $message, ?\DateTimeImmutable $reserveAt = null): AlimtalkSendResult
    {
        $results = $this->sendBatch([$message], $reserveAt);

        return $results[0];
    }

    /**
     * SENS accepts one template per request, so messages are grouped by
     * (templateCode, channel) and each group is chunked at 100.
     *
     * @param list<AlimtalkMessage> $messages
     * @return list<AlimtalkSendResult>
     */
    public function sendBatch(array $messages, ?\DateTimeImmutable $reserveAt = null): array
    {
        if ($messages === []) {
            return [];
        }

        $groups = [];
        foreach ($messages as $message) {
            $groups[$message->templateCode . '|' . $message->plusFriendId][] = $message;
        }

        $results = [];
        foreach ($groups as $group) {
            foreach (array_chunk($group, self::MAX_MESSAGES_PER_REQUEST) as $chunk) {
                $results[] = $this->dispatch($chunk, $reserveAt);
            }
        }

        return $results;
    }

    public function fetchDelivery(string $messageId): AlimtalkDeliveryResult
    {
        $uriPath = sprintf(
            '/alimtalk/v2/services/%s/messages/%s',
            $this->serviceIdPath(),
            rawurlencode($messageId),
        );

        $response = $this->http->send(new HttpRequest(
            method: 'GET',
            url: $this->config->baseUrl . $uriPath,
            headers: $this->buildHeaders('GET', $uriPath, false),
            timeoutSeconds: $this->config->timeoutSeconds,
        ));

        if (!$response->isSuccess()) {
            throw SensException::fromHttpStatus($response->status, $response->body, $uriPath);
        }

        return AlimtalkDeliveryResult::fromResponse($response->json());
    }

    /** @param list<AlimtalkMessage> $chunk */
    private function dispatch(array $chunk, ?\DateTimeImmutable $reserveAt): AlimtalkSendResult
    {
        $first = $chunk[0];
        $uriPath = sprintf('/alimtalk/v2/services/%s/messages', $this->serviceIdPath());

        $body = [
            'plusFriendId' => $first->plusFriendId,
            'templateCode' => $first->templateCode,
            'messages' => array_map(static fn (AlimtalkMessage $m): array => $m->toPayload(), $chunk),
        ];
        if ($reserveAt !== null) {
            $body['reserveTime'] = $reserveAt->format('Y-m-d H:i');
            $body['reserveTimeZone'] = 'Asia/Seoul';
        }

        $payload = json_encode($body, JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR);

        $response = $this->http->send(new HttpRequest(
            method: 'POST',
            url: $this->config->baseUrl . $uriPath,
            headers: $this->buildHeaders('POST', $uriPath, true),
            body: $payload,
            timeoutSeconds: $this->config->timeoutSeconds,
        ));

        if (!$response->isSuccess()) {
            throw SensException::fromHttpStatus($response->status, $response->body, $uriPath);
        }

        $result = AlimtalkSendResult::fromResponse($response->json());
        if (!$result->isAccepted()) {
            throw new SensException(
                'SENS did not accept the message: ' . $result->statusName,
                $response->status,
                $response->body,
                'Check requestId/statusCode and that the template is approved.',
            );
        }

        return $result;
    }

    /** Service ids contain colons; keep them literal but strip anything else. */
    private function serviceIdPath(): string
    {
        $safe = preg_replace('/[^A-Za-z0-9:\-_.]/', '', $this->config->serviceId) ?? '';

        return $safe !== '' ? $safe : $this->config->serviceId;
    }

    /** @return array<string,string> */
    private function buildHeaders(string $method, string $uriPath, bool $withBody): array
    {
        $timestamp = $this->clock->epochMillisAsString();

        $headers = [
            'x-ncp-apigw-timestamp' => $timestamp,
            'x-ncp-iam-access-key' => $this->config->accessKey,
            'x-ncp-apigw-signature-v2' => $this->signatureFor($method, $uriPath, $timestamp),
        ];
        if ($withBody) {
            $headers['Content-Type'] = 'application/json; charset=utf-8';
        }

        return $headers;
    }
}
