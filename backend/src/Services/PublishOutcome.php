<?php

declare(strict_types=1);

namespace Shortform\Services;

/** Result of an orchestrated publish, in the shape the worker logs and the API returns. */
final readonly class PublishOutcome
{
    /**
     * @param array<string,mixed> $detail
     */
    public function __construct(
        public string $status,
        public ?string $mediaId = null,
        public ?string $permalink = null,
        public ?int $errorCode = null,
        public string $message = '',
        public bool $retryable = false,
        public array $detail = [],
    ) {
    }

    public function succeeded(): bool
    {
        return $this->status === 'published';
    }

    /** @return array<string,mixed> */
    public function toArray(): array
    {
        return [
            'status' => $this->status,
            'mediaId' => $this->mediaId,
            'permalink' => $this->permalink,
            'errorCode' => $this->errorCode,
            'message' => $this->message,
            'retryable' => $this->retryable,
            'detail' => $this->detail,
        ];
    }
}
