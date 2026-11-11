<?php

declare(strict_types=1);

namespace Shortform\Sens;

/**
 * One alimtalk message. Content is the rendered body of a reviewed template
 * (variables substituted, never invented copy) and is capped at 1,000 chars.
 */
final readonly class AlimtalkMessage
{
    public string $recipientDigits;
    public string $countryCode;

    public function __construct(
        public string $to,
        public string $content,
        public string $templateCode,
        public string $plusFriendId,
        public ?string $failoverFrom = null,
        public bool $useSmsFailover = false,
    ) {
        if (trim($content) === '') {
            throw new \InvalidArgumentException('Alimtalk content is empty.');
        }
        if (mb_strlen($content) > 1000) {
            throw new \InvalidArgumentException('Alimtalk content exceeds 1,000 characters.');
        }

        $phone = RecipientPhone::fromString($to);
        $this->recipientDigits = $phone->digits;
        $this->countryCode = $phone->countryCode;
    }

    /** @return array<string,mixed> */
    public function toPayload(): array
    {
        $payload = [
            'countryCode' => $this->countryCode,
            'to' => $this->recipientDigits,
            'content' => $this->content,
        ];

        if ($this->useSmsFailover && $this->failoverFrom !== null) {
            $payload['useSmsFailover'] = true;
            $payload['failoverConfig'] = [
                'type' => mb_strlen($this->content) > 90 ? 'LMS' : 'SMS',
                'from' => preg_replace('/\D+/', '', $this->failoverFrom),
                'content' => $this->content,
            ];
        }

        return $payload;
    }

    /** @return array<string,mixed> */
    public function toAuditArray(): array
    {
        $payload = $this->toPayload();
        $payload['to'] = RecipientPhone::fromString($this->to)->masked();

        return $payload;
    }
}
