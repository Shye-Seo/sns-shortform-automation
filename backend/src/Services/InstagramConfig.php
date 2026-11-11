<?php

declare(strict_types=1);

namespace Shortform\Services;

/** Immutable Graph API credentials/settings for one business account. */
final readonly class InstagramConfig
{
    public function __construct(
        public string $igUserId,
        public string $accessToken,
        public string $apiVersion = 'v21.0',
        public string $baseUrl = 'https://graph.facebook.com',
        public int $pollIntervalMs = 2_000,
        public int $pollTimeoutMs = 180_000,
        public int $maxRetries = 3,
    ) {
        if ($igUserId === '' || $accessToken === '') {
            throw new \InvalidArgumentException('IG_USER_ID and IG_ACCESS_TOKEN are required.');
        }
    }

    public function graphBase(): string
    {
        return rtrim($this->baseUrl, '/') . '/' . $this->apiVersion;
    }
}
