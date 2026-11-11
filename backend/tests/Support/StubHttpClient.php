<?php

declare(strict_types=1);

namespace Shortform\Tests\Support;

use Shortform\Support\HttpClient;
use Shortform\Support\HttpRequest;
use Shortform\Support\HttpResponse;

final class StubHttpClient implements HttpClient
{
    /** @var list<HttpRequest> */
    public array $requests = [];

    /** @var list<HttpResponse|\Throwable> */
    private array $queue = [];

    public function queueResponse(int $status, string $body, array $headers = []): self
    {
        $this->queue[] = new HttpResponse($status, $body, $headers);

        return $this;
    }

    public function queueJson(int $status, array $payload): self
    {
        return $this->queueResponse($status, json_encode($payload, JSON_UNESCAPED_UNICODE) ?: '{}');
    }

    public function queueThrowable(\Throwable $error): self
    {
        $this->queue[] = $error;

        return $this;
    }

    public function send(HttpRequest $request): HttpResponse
    {
        $this->requests[] = $request;

        if ($this->queue === []) {
            throw new \LogicException('StubHttpClient: no queued response.');
        }

        $next = array_shift($this->queue);
        if ($next instanceof \Throwable) {
            throw $next;
        }

        return $next;
    }

    public function lastRequest(): ?HttpRequest
    {
        return $this->requests === [] ? null : $this->requests[array_key_last($this->requests)];
    }
}
