<?php

declare(strict_types=1);

namespace Shortform\Services;

/**
 * Graph API failure with the resolution attached.
 *
 * The Meta error catalogue is large, but only a handful of codes are actually actionable
 * in this pipeline. Mapping them here means the operator reads "token expired, refresh it"
 * instead of "OAuthException (#190)".
 */
final class InstagramApiException extends \RuntimeException
{
    public function __construct(
        string $message,
        public readonly int $metaCode = 0,
        public readonly int $httpStatus = 0,
        public readonly bool $retryable = false,
        public readonly string $hint = '',
        public readonly string $responseBody = '',
    ) {
        parent::__construct($message);
    }

    /** @param array<string,mixed> $error the `error` object of a Graph API response */
    public static function fromMetaError(array $error, int $httpStatus): self
    {
        $code = (int) ($error['code'] ?? 0);
        $subcode = (int) ($error['error_subcode'] ?? 0);
        $message = (string) ($error['message'] ?? 'Unknown Graph API error');

        [$retryable, $hint] = match (true) {
            $code === 9007 => [true, 'Container is still IN_PROGRESS; poll status_code until FINISHED before publishing.'],
            $code === 9004 => [false, 'Meta could not download video_url: it must be public HTTPS and reachable without auth.'],
            $code === 190 => [false, 'Access token expired or revoked; refresh the long-lived token for this account.'],
            in_array($code, [4, 17, 32, 613], true) => [true, 'App/user rate limit reached; back off and retry later.'],
            $code === 10 || $subcode === 33 => [false, 'Missing permission: instagram_content_publish scope or app review status.'],
            $code === 100 => [false, 'Invalid parameter; check media_type, caption length and video_url.'],
            $code === 352 => [false, 'Video rejected by Meta (aspect ratio, codec or duration).'],
            $httpStatus >= 500 => [true, 'Meta server error; retry with backoff.'],
            default => [false, 'See the Graph API response body for details.'],
        };

        return new self(
            message: "Instagram Graph API error ({$code}): {$message}",
            metaCode: $code,
            httpStatus: $httpStatus,
            retryable: $retryable,
            hint: $hint,
            responseBody: json_encode($error, JSON_UNESCAPED_UNICODE) ?: '',
        );
    }

    public function needsTokenRefresh(): bool
    {
        return $this->metaCode === 190;
    }
}
