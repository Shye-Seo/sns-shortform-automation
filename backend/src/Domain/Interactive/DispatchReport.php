<?php

declare(strict_types=1);

namespace Shortform\Domain\Interactive;

/**
 * One dispatch cycle report (what a worker did in this pass).
 */
final class DispatchReport
{
    /**
     * @param array<string,int> $counts dispatched/retried/deadLettered/late
     */
    public function __construct(
        public readonly array $counts,
        public readonly float $worstLatencyMs = 0.0,
    ) {
    }

    public function dispatched(): int
    {
        return $this->counts['dispatched'] ?? 0;
    }

    public function deadLettered(): int
    {
        return $this->counts['deadLettered'] ?? 0;
    }

    public function retried(): int
    {
        return $this->counts['retried'] ?? 0;
    }

    /**
     * Share of finished work that met the SLA (0..1).
     *
     * Denominator is "dispatched + late", not "dispatched": a run where every job missed the
     * deadline and was dead-lettered would otherwise report 100% compliance, which is the exact
     * opposite of what an operator needs to see.
     */
    public function slaCompliance(): float
    {
        $late = $this->counts['late'] ?? 0;
        $finished = $this->dispatched() + $late;

        return $finished === 0 ? 1.0 : $this->dispatched() / $finished;
    }
}
