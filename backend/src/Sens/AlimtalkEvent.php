<?php

declare(strict_types=1);

namespace Shortform\Sens;

/**
 * Why a notification is sent. Each event has exactly one Kakao-approved template,
 * because alimtalk content must match a template that passed review (SENS rejects a
 * body that does not match with 3016 NoMatchedTemplate).
 */
enum AlimtalkEvent: string
{
    case RenderCompleted = 'render_completed';
    case PublishCompleted = 'publish_completed';
    case PublishFailed = 'publish_failed';
    case QuotaExhausted = 'quota_exhausted';

    public function audience(): string
    {
        return match ($this) {
            self::RenderCompleted, self::PublishCompleted => 'creator',
            self::PublishFailed, self::QuotaExhausted => 'operator',
        };
    }
}
