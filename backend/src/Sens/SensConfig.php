<?php

declare(strict_types=1);

namespace Shortform\Sens;

/**
 * SENS connection settings. Everything comes from the environment: service id, channel
 * id and template codes change without a code deploy (templates are re-reviewed).
 */
final readonly class SensConfig
{
    /**
     * @param array<string,string> $templateCodes event value => template code
     */
    public function __construct(
        public string $accessKey,
        public string $secretKey,
        public string $serviceId,
        public string $plusFriendId,
        public array $templateCodes,
        public ?string $failoverFrom = null,
        public string $baseUrl = 'https://sens.apigw.ntruss.com',
        public int $timeoutSeconds = 10,
    ) {
        if ($accessKey === '' || $secretKey === '') {
            throw new \InvalidArgumentException('SENS access/secret key is empty.');
        }
        if ($serviceId === '') {
            throw new \InvalidArgumentException('SENS service id is empty.');
        }
        if (!str_starts_with($plusFriendId, '@')) {
            throw new \InvalidArgumentException('Kakao channel id must start with @ (e.g. @shortform).');
        }
    }

    public function templateFor(AlimtalkEvent $event): string
    {
        $code = $this->templateCodes[$event->value] ?? null;
        if ($code === null) {
            throw new \InvalidArgumentException("No SENS template configured for {$event->value}.");
        }

        return $code;
    }

    /** @return array<string,string> */
    public static function defaultTemplateCodes(): array
    {
        return [
            'render_completed' => 'SF_RENDER_DONE',
            'publish_completed' => 'SF_PUBLISH_DONE',
            'publish_failed' => 'SF_PUBLISH_FAILED',
            'quota_exhausted' => 'SF_QUOTA_EXHAUSTED',
        ];
    }
}
