<?php

declare(strict_types=1);

namespace Shortform\Tests\Support;

use Shortform\Repositories\NotificationSender;
use Shortform\Repositories\SendResult;

/**
 * Scripted notification gateway.
 *
 * Records every send so a test can assert what the user would have received (deep link, template,
 * reward label), and lets the test choose the failure mode of the next sends:
 *   queue(['retryable', 'ok']) → first send fails (retryable), second succeeds.
 */
final class ScriptedNotificationSender implements NotificationSender
{
    /** @var list<string> */
    private array $script;

    /** @var list<array{channel:string, recipient:string, payload:array<string,mixed>}> */
    public array $sent = [];

    /** @param list<string> $script outcomes in order: ok | retryable | permanent */
    public function __construct(array $script = [])
    {
        $this->script = $script;
    }

    public function send(string $channel, string $recipientRef, array $payload): SendResult
    {
        $this->sent[] = ['channel' => $channel, 'recipient' => $recipientRef, 'payload' => $payload];
        $outcome = $this->script === [] ? 'ok' : array_shift($this->script);

        return match ($outcome) {
            'retryable' => SendResult::retryableFailure('Meta DM rate limited', 12.0),
            'permanent' => SendResult::permanentFailure('recipient blocked', 8.0),
            default => SendResult::delivered('msg-' . count($this->sent), 240.0),
        };
    }

    public function lastPayload(): array
    {
        return $this->sent === [] ? [] : $this->sent[count($this->sent) - 1]['payload'];
    }
}
