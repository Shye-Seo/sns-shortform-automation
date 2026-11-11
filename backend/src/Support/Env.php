<?php

declare(strict_types=1);

namespace Shortform\Support;

/**
 * Minimal .env loader (no dependency).
 * Real environment variables always win: deployed platforms inject them, and a stale
 * .env must never be able to override production settings.
 */
final class Env
{
    private static bool $loaded = false;

    public static function load(string $path): void
    {
        if (self::$loaded || !is_readable($path)) {
            return;
        }
        self::$loaded = true;

        $lines = file($path, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) ?: [];
        foreach ($lines as $line) {
            $line = trim($line);
            if ($line === '' || str_starts_with($line, '#') || !str_contains($line, '=')) {
                continue;
            }
            [$key, $value] = explode('=', $line, 2);
            $key = trim($key);
            $value = trim($value);
            if ($value !== '' && ($value[0] === '"' || $value[0] === "'")) {
                $value = substr($value, 1, -1);
            }
            if ($key === '' || getenv($key) !== false) {
                continue;
            }
            putenv("{$key}={$value}");
            $_ENV[$key] = $value;
        }
    }

    public static function get(string $key, ?string $default = null): ?string
    {
        $value = getenv($key);

        return ($value === false || $value === '') ? $default : $value;
    }

    public static function required(string $key): string
    {
        $value = self::get($key);
        if ($value === null) {
            throw new \RuntimeException("Missing environment variable {$key} (see backend/.env.example).");
        }

        return $value;
    }

    public static function int(string $key, int $default = 0): int
    {
        $value = self::get($key);

        return $value === null ? $default : (int) $value;
    }

    public static function bool(string $key, bool $default = false): bool
    {
        $value = self::get($key);
        if ($value === null) {
            return $default;
        }

        return in_array(strtolower($value), ['1', 'true', 'yes', 'on'], true);
    }
}
