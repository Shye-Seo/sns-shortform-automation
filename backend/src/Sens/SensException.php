<?php

declare(strict_types=1);

namespace Shortform\Sens;

/** SENS call failure, carrying the operator action that resolves it. */
final class SensException extends \RuntimeException
{
    public function __construct(
        string $message,
        public readonly int $httpStatus = 0,
        public readonly string $responseBody = '',
        public readonly string $hint = '',
    ) {
        parent::__construct($message, $httpStatus);
    }

    public static function fromHttpStatus(int $status, string $body, string $uriPath): self
    {
        $hint = match (true) {
            $status === 401 => 'Signature rejected: check access/secret keys and server clock (timestamp drifts >5min).',
            $status === 403 => 'No permission for this SENS service; check sub-account roles and service id.',
            $status === 404 => "Wrong service id or path: {$uriPath}",
            $status === 429 => 'Rate limit exceeded; group messages or back off exponentially.',
            $status >= 500 => 'NCP server error; the same request can be retried, but avoid duplicate sends.',
            default => 'Check that template code, channel id and recipient match the reviewed template.',
        };

        return new self("SENS call failed (HTTP {$status})", $status, $body, $hint);
    }

    public function isRetryable(): bool
    {
        return $this->httpStatus === 429 || $this->httpStatus >= 500;
    }
}
