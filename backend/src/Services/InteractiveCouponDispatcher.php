<?php

declare(strict_types=1);

namespace Shortform\Services;

use Shortform\Domain\Interactive\ClaimResult;
use Shortform\Domain\Interactive\ClaimToken;
use Shortform\Domain\Interactive\DispatchJob;
use Shortform\Domain\Interactive\DispatchReport;
use Shortform\Domain\Interactive\InteractiveCampaign;
use Shortform\Domain\Interactive\WebhookComment;
use Shortform\Domain\Interactive\WebhookHandlingResult;
use Shortform\Repositories\CampaignCatalog;
use Shortform\Repositories\ClaimTokenStore;
use Shortform\Repositories\DispatchQueueStore;
use Shortform\Repositories\InteractionEventStore;
use Shortform\Repositories\NotificationSender;
use Shortform\Security\HmacTokenSigner;
use Shortform\Support\Clock;

/**
 * Comment → coupon dispatch pipeline.
 *
 * The whole point is a **5 second** user-perceived SLA, and the only way to keep it is to make the
 * webhook path do as little as possible:
 *
 *   webhook : verify → parse → match → dedupe → score → enqueue            (~10 ms)
 *   worker  : claim → mint token → send → mark                             (~300-800 ms)
 *
 * If sending happened inline, Meta would time out (its budget is ~5 s), retry the webhook, and
 * each retry would send another DM. That is how a "cute event" turns into 3 duplicate coupons per
 * user.
 *
 * Ordering inside the webhook path is deliberate:
 *   1. signature first — an unverified payload never reaches the parsers or the database
 *   2. parse before campaign lookup — a malformed payload should be a 400, not a 200
 *   3. event insert before fraud scoring — the score depends on recent rows including this one,
 *      and the insert is what enforces the dedupe key
 *   4. fraud before enqueue — blocked accounts must not consume budget
 */
final class InteractiveCouponDispatcher
{
    public function __construct(
        private readonly CampaignCatalog $campaigns,
        private readonly InteractionEventStore $events,
        private readonly DispatchQueueStore $queue,
        private readonly ClaimTokenStore $tokens,
        private readonly NotificationSender $sender,
        private readonly HmacTokenSigner $signer,
        private readonly FraudDetectionService $fraud,
        private readonly Clock $clock,
        private readonly int $slaSeconds = 5,
        private readonly int $maxAttempts = 5,
        private readonly string $deepLinkBase = 'https://coupon.shye.kr/c',
    ) {
    }

    /**
     * @param array<string,mixed> $payload decoded webhook body
     */
    public function handleWebhook(array $payload, bool $signatureValid, ?string $clientIp = null): WebhookHandlingResult
    {
        $counts = ['processed' => 0, 'accepted' => 0, 'enqueued' => 0, 'ignored' => 0, 'duplicate' => 0, 'abuse' => 0, 'rejected' => 0];

        // 1) 서명이 틀린 요청은 파싱도 하지 않는다(공격자 데이터를 DB에 넣지 않는다).
        if (! $signatureValid) {
            $counts['rejected'] = 1;

            return new WebhookHandlingResult(false, $counts, 'BAD_SIGNATURE');
        }

        $comments = $this->parse($payload);
        if ($comments === []) {
            return new WebhookHandlingResult(true, $counts, 'NO_COMMENTS');
        }

        $now = $this->clock->now();

        foreach ($comments as $comment) {
            $counts['processed']++;

            $campaign = $this->campaigns->findLiveByContent($comment->platform, $comment->contentRef, $now);
            if ($campaign === null) {
                // 우리 콘텐츠가 아니거나 끝난 캠페인. 테넌트를 모르므로 이벤트를 저장하지 않는다.
                $counts['ignored']++;
                continue;
            }

            $keyword = $campaign->matchKeyword($comment->text);
            $verdict = $this->fraud->assess($comment, $clientIp);

            $status = match (true) {
                $keyword === null => 'IGNORED',
                $verdict->isBlocked() => 'REJECTED',
                default => 'QUEUED',
            };
            $reason = match (true) {
                $keyword === null => 'NO_KEYWORD',
                $verdict->isBlocked() => 'ABUSE:' . $verdict->summary(),
                default => null,
            };

            // 2) 멱등 INSERT. 같은 댓글 웹훅이 다시 오면 null → DUPLICATE.
            $eventId = $this->events->record(
                tenantId: $campaign->tenantId,
                campaignId: $campaign->id,
                comment: $comment,
                status: $status,
                matchedKeyword: $keyword,
                signatureVerified: true,
                rejectionReason: $reason,
            );

            if ($eventId === null) {
                $counts['duplicate']++;
                continue;
            }

            if ($keyword === null) {
                $counts['ignored']++;
                continue;
            }

            if ($verdict->isBlocked()) {
                $counts['abuse']++;
                continue;
            }

            // 3) 예산·장수 상한 — 차단된 트래픽이 예산을 먹지 않게 발급 전에 확인한다.
            if (! $this->hasBudget($campaign)) {
                $this->events->markStatus($eventId, 'IGNORED', 'BUDGET_EXHAUSTED', $now);
                $counts['ignored']++;
                continue;
            }

            $counts['accepted']++;

            // 4) 큐 적재(5초 데드라인). 발송은 워커가 한다.
            $queueId = $this->queue->enqueue(
                campaignId: $campaign->id,
                eventId: $eventId,
                channel: $comment->platform === 'instagram' ? 'INSTAGRAM_DM' : 'ALIMTALK',
                recipientRef: $comment->authorRef,
                idempotencyKey: sprintf('event:%d:dm:%s', $eventId, $comment->authorRef),
                deadline: $now->modify("+{$this->slaSeconds} seconds"),
                payload: [
                    'campaignCode' => $campaign->code,
                    'rewardLabel' => $campaign->rewardLabel,
                    'rewardAmount' => $campaign->rewardAmount,
                ],
                now: $now,
            );

            if ($queueId === null) {
                // 같은 이벤트·같은 수신자로 이미 큐에 있다(워커 재시작·중복 선점).
                $counts['duplicate']++;
                continue;
            }

            $counts['enqueued']++;
        }

        return new WebhookHandlingResult(true, $counts);
    }

    /**
     * Worker pass: claim due jobs, mint a one-time token, send, record the outcome.
     */
    public function dispatchPending(int $limit = 50): DispatchReport
    {
        $now = $this->clock->now();
        $jobs = $this->queue->claimReady($now, $limit);

        $counts = ['dispatched' => 0, 'retried' => 0, 'deadLettered' => 0, 'late' => 0];
        $worstLatency = 0.0;

        foreach ($jobs as $job) {
            // 데드라인을 넘긴 건은 "늦게라도 보내지" 않는다. 사용자는 이미 앱을 떠났고, 늦은
            // 쿠폰은 CS 비용만 만든다. DLQ에서 원인(플랫폼 지연/한도)을 본다.
            if ($job->isPastDeadline($now)) {
                $this->queue->markDeadLetter($job->id, $now, 'SLA_EXCEEDED');
                $counts['deadLettered']++;
                $counts['late']++;
                continue;
            }

            $campaign = $this->campaigns->findById($job->campaignId);
            if ($campaign === null) {
                $this->queue->markDeadLetter($job->id, $now, 'CAMPAIGN_NOT_FOUND');
                $counts['deadLettered']++;
                continue;
            }

            $token = $this->mintToken($campaign, $job, $now);
            $startedAt = microtime(true);

            $result = $this->sender->send($job->channel, $job->recipientRef, [
                'templateCode' => 'shortform_claim_v1',
                'deepLink' => rtrim($this->deepLinkBase, '/') . '/' . rawurlencode($token['plain']),
                'rewardLabel' => $campaign->rewardLabel,
                'campaignCode' => $campaign->code,
            ]);

            $latency = $result->latencyMs > 0 ? $result->latencyMs : (microtime(true) - $startedAt) * 1000;
            $worstLatency = max($worstLatency, $latency + $token['elapsedMs']);

            if ($result->ok) {
                $this->queue->markDispatched($job->id, $now);
                $counts['dispatched']++;
                continue;
            }

            $attempts = $job->attempts + 1;
            if ($result->retryable && $attempts < $this->maxAttempts) {
                $nextAt = $now->modify('+' . $job->backoffSeconds() . ' seconds');
                $this->queue->markRetry($job->id, $nextAt, $result->error);
                $counts['retried']++;
                continue;
            }

            $this->queue->markDeadLetter($job->id, $now, $result->error !== '' ? $result->error : 'PERMANENT_FAILURE');
            $counts['deadLettered']++;
        }

        return new DispatchReport($counts, $worstLatency);
    }

    /**
     * Click on the deep link.
     */
    public function claim(string $plainToken, ?string $ip = null): ClaimResult
    {
        $now = $this->clock->now();
        $token = $this->tokens->findByHash(hash('sha256', $plainToken));

        if ($token === null) {
            return ClaimResult::rejected('NOT_FOUND', '링크가 올바르지 않습니다.');
        }

        if ($token->isExpiredAt($now)) {
            $this->tokens->markExpired($token->id);

            return ClaimResult::rejected('EXPIRED', '링크 유효 시간이 지났습니다.');
        }

        if ($token->isClaimed || $token->claimCount > 0) {
            return ClaimResult::rejected('ALREADY_CLAIMED', '이미 사용된 링크입니다.');
        }

        if (! $this->signer->verify($token->uuid, $token->expiresAt, $token->signature)) {
            return ClaimResult::rejected('BAD_SIGNATURE', '링크 서명이 올바르지 않습니다.');
        }

        // CAS: 동시에 두 번 눌러도 한 번만 성공한다.
        if (! $this->tokens->claim($token->id, $now, $ip)) {
            return ClaimResult::rejected('ALREADY_CLAIMED', '동시 요청으로 다른 클릭이 먼저 사용했습니다.');
        }

        return ClaimResult::granted($token->rewardAmount);
    }

    /**
     * Parse Instagram (Meta Graph) and YouTube shapes into one internal type.
     *
     * Both shapes are supported because the same campaign can run on Reels and Shorts and the
     * operator console shows them together. Unknown shapes are ignored, never fatal: Meta
     * occasionally adds fields, and a 500 would make it retry forever.
     *
     * @param array<string,mixed> $payload
     * @return list<WebhookComment>
     */
    public function parse(array $payload): array
    {
        $now = $this->clock->now();
        $comments = [];

        if (($payload['object'] ?? null) === 'instagram' && isset($payload['entry']) && is_array($payload['entry'])) {
            foreach ($payload['entry'] as $entry) {
                if (! is_array($entry)) {
                    continue;
                }
                foreach ($entry['changes'] ?? [] as $change) {
                    $value = is_array($change) ? ($change['value'] ?? null) : null;
                    if (! is_array($value) || ! isset($value['id'])) {
                        continue;
                    }
                    $comments[] = new WebhookComment(
                        externalEventId: (string) $value['id'],
                        platform: 'instagram',
                        contentRef: (string) ($value['media']['id'] ?? ''),
                        authorRef: (string) ($value['from']['id'] ?? ''),
                        authorHandleRef: isset($value['from']['username']) ? (string) $value['from']['username'] : null,
                        text: (string) ($value['text'] ?? ''),
                        receivedAt: $now,
                    );
                }
            }

            return $comments;
        }

        if (isset($payload['events']) && is_array($payload['events'])) {
            foreach ($payload['events'] as $event) {
                if (! is_array($event) || ! isset($event['id'])) {
                    continue;
                }
                $comments[] = new WebhookComment(
                    externalEventId: (string) $event['id'],
                    platform: (string) ($event['platform'] ?? 'youtube'),
                    contentRef: (string) ($event['videoId'] ?? ''),
                    authorRef: (string) ($event['authorChannelId'] ?? ''),
                    authorHandleRef: null,
                    text: (string) ($event['text'] ?? ''),
                    receivedAt: $now,
                    isNewAccount: (bool) ($event['isNewAccount'] ?? false),
                );
            }
        }

        return $comments;
    }

    /**
     * @return array{plain:string, uuid:string, elapsedMs:float}
     */
    private function mintToken(InteractiveCampaign $campaign, DispatchJob $job, \DateTimeImmutable $now): array
    {
        $startedAt = microtime(true);
        $uuid = self::uuidV4($job->id . ':' . $job->idempotencyKey);
        $secret = $this->signer->newSecret();
        $plain = $uuid . '.' . $secret;
        $expiresAt = $now->modify("+{$campaign->tokenTtlMinutes} minutes");

        $this->tokens->issue(new ClaimToken(
            id: 0,
            campaignId: $campaign->id,
            dispatchId: $job->id,
            uuid: $uuid,
            hash: hash('sha256', $plain),
            signature: $this->signer->sign($uuid, $expiresAt),
            rewardAmount: $campaign->rewardAmount,
            isClaimed: false,
            claimCount: 0,
            claimedAt: null,
            expiresAt: $expiresAt,
            createdAt: $now,
        ));

        return ['plain' => $plain, 'uuid' => $uuid, 'elapsedMs' => (microtime(true) - $startedAt) * 1000];
    }

    private function hasBudget(InteractiveCampaign $campaign): bool
    {
        $usage = $this->campaigns->usage($campaign->id);

        if ($campaign->claimLimit > 0 && $usage['claims'] >= $campaign->claimLimit) {
            return false;
        }

        if ($campaign->totalRewardBudget > 0 && $usage['rewardTotal'] >= $campaign->totalRewardBudget) {
            return false;
        }

        return true;
    }

    public static function uuidV4(string $seed): string
    {
        $hash = hash('sha256', $seed, true);
        $hash[6] = chr((ord($hash[6]) & 0x0f) | 0x40);
        $hash[8] = chr((ord($hash[8]) & 0x3f) | 0x80);
        $hex = bin2hex(substr($hash, 0, 16));

        return sprintf(
            '%s-%s-%s-%s-%s',
            substr($hex, 0, 8),
            substr($hex, 8, 4),
            substr($hex, 12, 4),
            substr($hex, 16, 4),
            substr($hex, 20, 12),
        );
    }
}
