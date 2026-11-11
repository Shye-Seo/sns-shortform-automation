<?php

declare(strict_types=1);

namespace Shortform\Domain;

/** Publish lifecycle for a project/platform pair. */
enum PublishStatus: string
{
    case ContainerCreated = 'container_created';
    case InProgress = 'in_progress';
    case Published = 'published';
    case Failed = 'failed';
    case Expired = 'expired';

    public function isTerminal(): bool
    {
        return in_array($this, [self::Published, self::Failed, self::Expired], true);
    }
}
