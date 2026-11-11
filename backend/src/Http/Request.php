<?php

declare(strict_types=1);

namespace Shortform\Http;

/** Small request object; the API surface is four routes, so a framework would be noise. */
final readonly class Request
{
    /**
     * @param array<string,string> $headers lower-cased
     * @param array<string,string> $query
     * @param array<string,mixed> $json
     */
    public function __construct(
        public string $method,
        public string $path,
        public array $headers,
        public array $query,
        public array $json,
        public string $rawBody,
        public ?string $clientIp = null,
    ) {
    }

    public static function fromGlobals(): self
    {
        $headers = [];
        foreach ($_SERVER as $key => $value) {
            if (str_starts_with($key, 'HTTP_')) {
                $headers[strtolower(str_replace('_', '-', substr($key, 5)))] = (string) $value;
            }
        }
        if (isset($_SERVER['CONTENT_TYPE'])) {
            $headers['content-type'] = (string) $_SERVER['CONTENT_TYPE'];
        }

        $raw = file_get_contents('php://input') ?: '';
        $json = [];
        if (trim($raw) !== '' && str_contains($headers['content-type'] ?? '', 'json')) {
            $decoded = json_decode($raw, true);
            if (!is_array($decoded)) {
                throw new BadRequestException('Request body is not valid JSON.');
            }
            $json = $decoded;
        }

        return new self(
            method: strtoupper($_SERVER['REQUEST_METHOD'] ?? 'GET'),
            path: rtrim(parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/', '/') ?: '/',
            headers: $headers,
            query: array_map('strval', $_GET),
            json: $json,
            rawBody: $raw,
            clientIp: $_SERVER['REMOTE_ADDR'] ?? null,
        );
    }

    public function header(string $name): ?string
    {
        return $this->headers[strtolower($name)] ?? null;
    }

    public function queryString(string $key): ?string
    {
        $value = $this->query[$key] ?? null;

        return $value === null || $value === '' ? null : $value;
    }
}
