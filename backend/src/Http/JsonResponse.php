<?php

declare(strict_types=1);

namespace Shortform\Http;

final class JsonResponse
{
    public static function send(array $payload, int $status = 200): void
    {
        if (!headers_sent()) {
            http_response_code($status);
            header('Content-Type: application/json; charset=utf-8');
            header('Cache-Control: no-store');
        }
        echo json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    }

    public static function error(string $code, string $message, int $status = 400, array $details = []): void
    {
        self::send(['error' => ['code' => $code, 'message' => $message, 'details' => $details]], $status);
    }
}
