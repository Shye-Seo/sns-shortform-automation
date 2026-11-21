<?php

declare(strict_types=1);

/**
 * Router for PHP's built-in server.
 *
 *   php -S 127.0.0.1:8081 -t backend/public backend/public/router.php
 *
 * Without it, the built-in server treats a path whose last segment contains a dot as a
 * static file request and answers 404 before index.php runs. Claim links are
 * `/c/{uuid}.{secret}` — exactly that shape — so the one route users click would never
 * reach the application. Production uses `try_files $uri /index.php` in nginx for the same
 * reason; this is the development equivalent.
 */

$path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';
$file = __DIR__ . $path;

if ($path !== '/' && is_file($file)) {
    return false;
}

require __DIR__ . '/index.php';
