<?php

declare(strict_types=1);

namespace Shortform\Tests\Support;

use Shortform\Repositories\NotificationStore;
use Shortform\Sens\AlimtalkMessage;
use Shortform\Sens\AlimtalkSendResult;

final class FakeNotificationStore implements NotificationStore
{
    /** @var array<string,int> dedupeKey => id */
    public array $claimed = [];

    /** @var list<array{id:int,error:string}> */
    public array $failures = [];

    /** @var list<array{id:int,requestId:string}> */
    public array $accepted = [];

    /** @var list<string> */
    public array $events = [];

    private int $nextId = 1;

    /** @param list<string> $alreadySent */
    public function __construct(array $alreadySent = [])
    {
        foreach ($alreadySent as $key) {
            $this->claimed[$key] = $this->nextId++;
        }
    }

    public function claim(
        int $tenantId,
        ?int $projectId,
        string $event,
        string $dedupeKey,
        string $templateCode,
        string $plusFriendId,
        string $recipientPhone,
        array $payload,
        \DateTimeImmutable $now,
    ): ?int {
        $this->events[] = $event;
        if (isset($this->claimed[$dedupeKey])) {
            return null;
        }
        $id = $this->nextId++;
        $this->claimed[$dedupeKey] = $id;

        return $id;
    }

    public function markAccepted(int $id, AlimtalkSendResult $result, AlimtalkMessage $message, \DateTimeImmutable $now): void
    {
        $this->accepted[] = ['id' => $id, 'requestId' => $result->requestId];
    }

    public function markNotificationFailed(int $id, string $error, \DateTimeImmutable $now): void
    {
        $this->failures[] = ['id' => $id, 'error' => $error];
    }
}
