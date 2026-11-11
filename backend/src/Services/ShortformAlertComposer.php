<?php

declare(strict_types=1);

namespace Shortform\Services;

use Shortform\Sens\AlimtalkEvent;

/**
 * Alimtalk body composition.
 *
 * Kakao alimtalk is not free-form SMS: the body must match a reviewed template with only
 * the declared variables substituted. So this class fills variables and never invents
 * sentences. The matching template bodies that must be registered in the SENS console are
 * listed below — keep them in sync with these methods.
 *
 *   SF_RENDER_DONE
 *     [#{tenant_name}] #{project_title} 렌더 완료
 *     길이 #{duration} · #{format}
 *     검수 후 발행을 승인해 주세요.
 *
 *   SF_PUBLISH_DONE
 *     [#{tenant_name}] #{platform_label} 발행 완료
 *     #{project_title}
 *     #{permalink}
 *
 *   SF_PUBLISH_FAILED
 *     [#{tenant_name}] 발행 실패 - #{project_title}
 *     원인: #{reason}
 *     조치: #{hint}
 *
 *   SF_QUOTA_EXHAUSTED
 *     [#{tenant_name}] 발행 쿼터 소진 (#{used}/#{total})
 *     #{reset_hint}
 *
 * Variable values are flattened to one line: a newline inside a variable breaks the
 * template match (3016) and makes the phone notification unreadable.
 */
final class ShortformAlertComposer
{
    public function __construct(private readonly string $consoleUrl = 'https://studio.shortform.example.com')
    {
    }

    public function renderCompleted(string $tenantName, string $projectTitle, float $durationSec, string $platformLabel): string
    {
        return mb_substr(sprintf(
            "[%s] %s 렌더 완료\n길이 %ss · %s\n검수 후 발행을 승인해 주세요.\n%s",
            $this->line($tenantName),
            $this->line($projectTitle, 40),
            rtrim(rtrim(number_format($durationSec, 1, '.', ''), '0'), '.'),
            $this->line($platformLabel),
            $this->consoleUrl,
        ), 0, 1000);
    }

    public function publishCompleted(string $tenantName, string $projectTitle, string $platformLabel, ?string $permalink): string
    {
        return mb_substr(sprintf(
            "[%s] %s 발행 완료\n%s\n%s",
            $this->line($tenantName),
            $this->line($platformLabel),
            $this->line($projectTitle, 40),
            $permalink ?? '링크 확인 중',
        ), 0, 1000);
    }

    public function publishFailed(string $tenantName, string $projectTitle, string $reason, string $hint): string
    {
        return mb_substr(sprintf(
            "[%s] 발행 실패 - %s\n원인: %s\n조치: %s",
            $this->line($tenantName),
            $this->line($projectTitle, 40),
            $this->line($reason, 120),
            $this->line($hint, 120),
        ), 0, 1000);
    }

    /** @param array{usage:int, total:int} $quota */
    public function quotaExhausted(string $tenantName, array $quota): string
    {
        return mb_substr(sprintf(
            "[%s] 발행 쿼터 소진 (%d/%d)\n24시간 뒤 자동으로 회복됩니다. 예약 발행은 다음 창으로 밀어 두세요.",
            $this->line($tenantName),
            $quota['usage'],
            $quota['total'],
        ), 0, 1000);
    }

    /** Dedupe keys: one per project+event, so a worker retry cannot send twice. */
    public function dedupeKey(int $tenantId, int $projectId, AlimtalkEvent $event): string
    {
        return sprintf('notify:%d:%d:%s', $tenantId, $projectId, $event->value);
    }

    private function line(string $value, int $maxLength = 60): string
    {
        $clean = preg_replace('/\s+/u', ' ', trim($value)) ?? '';

        return mb_strlen($clean) > $maxLength ? mb_substr($clean, 0, $maxLength - 1) . '…' : $clean;
    }
}
