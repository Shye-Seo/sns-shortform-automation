<?php

declare(strict_types=1);

namespace Shortform\Repositories;

/**
 * Outcome of applying a platform webhook.
 *
 * These are three different operational facts and must not be merged:
 *  - Applied:   the media row advanced (this is the happy path)
 *  - Duplicate: Meta re-delivered an event we already applied (no double counting)
 *  - Unknown:   no publish row for that media id — usually a webhook for a post
 *               published outside this platform (or before the row was written)
 */
enum WebhookApplyResult: string
{
    case Applied = 'applied';
    case Duplicate = 'duplicate';
    case Unknown = 'unknown';
}
