/**
 * 쿼터 인지 발행 스케줄러 (Quota-aware publish planner)
 *
 * 왜 이 모듈이 필요한가
 * ---------------------
 * 발행 단계는 지금 "쿼터가 없으면 거절"까지만 한다(`TenantRegistry.consume`). 그런데 대행사
 * 운영에서 거절은 곧 실패가 아니다. 8편을 예약했는데 YouTube 업로드가 1편당 1,600 unit이고
 * 하루 10,000 unit이면, 오늘은 6편까지만 나가고 나머지 2편은 **리셋 직후**에 나가야 한다.
 * 그 판단을 사람이 하면 매일 아침 스프레드시트로 쿼터를 다시 계산하게 된다.
 *
 * 이 모듈은 대기 중인 발행 작업 목록과 플랫폼 예산을 받아 **각 작업이 실제로 나갈 시각**을 낸다.
 * 작업은 실패하지 않는다. 예산이 없으면 다음 창(window)의 첫 슬롯으로 밀리고, 그 사실이
 * `reason`에 남는다.
 *
 * 설계 원칙
 * ---------
 * - **순수 함수**: `nowMs`와 예산을 인자로 받는다. 시계·네트워크·난수에 의존하지 않으므로 결과가
 *   재현되고 테스트로 고정할 수 있다.
 * - **결정적 순서**: 우선순위 desc → 희망 시각 asc → 작업 id asc. 같은 입력이면 같은 계획이 나온다.
 * - **창은 고정 길이**: 플랫폼 한도는 리셋 시각이 정해져 있다(YouTube는 태평양 자정). 창 시작과
 *   길이를 호출자가 주고, 첫 창은 이미 쓴 양(`usedUnits`)만큼 줄어든 상태로 시작한다.
 * - **슬롯과 쿼터는 다른 제약**: "몇 시에 올릴 수 있는가"(발행 슬롯)와 "몇 편까지 올릴 수
 *   있는가"(쿼터)를 분리한다. 슬롯을 벗어난 시각은 다음 슬롯 opening으로 민다.
 * - **최소 간격**: 같은 창에서 두 편이 거의 동시에 나가면 알고리즘 피드백이 서로를 오염시킨다.
 *   `minGapMs`를 지켜 배치한다.
 *
 * 실연동 범위: 이 계획은 로컬 계산이다. 실제 API 호출과 플랫폼 카운터 조회는 `TenantRegistry`와
 * 발행 어댑터가 담당하고, 계획은 그 앞단에서 "언제 보낼지"만 정한다.
 */

import { ShortformError } from '../errors';
import type { LimitDecision, ProviderId, TenantLimitView } from './tenantRegistry';

const MINUTE_MS = 60_000;
const DAY_MINUTES = 1_440;
const DAY_MS = DAY_MINUTES * MINUTE_MS;

export interface PublishJobRequest {
  id: string;
  /** 사용자가 희망한 발행 시각(ms). 없으면 `nowMs` */
  preferredAtMs?: number;
  /** 이 시각 이전에는 나가면 안 됨(검수·승인 대기) */
  notBeforeMs?: number;
  /** 높을수록 먼저 자리를 잡는다(기본 0) */
  priority?: number;
}

export interface BudgetWindow {
  /** 창 하나의 한도(플랫폼 단위) */
  limitUnits: number;
  /** 발행 1건이 쓰는 단위 */
  unitCost: number;
  /** 창 길이. 기본 24시간 */
  windowMs?: number;
  /** 첫 창의 시작 시각. 기본 `nowMs`(플랫폼 리셋 시각을 넘긴다) */
  windowStartMs?: number;
  /** 첫 창의 종료 시각(플랫폼 리셋 시각). 없으면 `windowStartMs + windowMs` */
  firstWindowEndMs?: number;
  /** 첫 창에서 이미 쓴 양 */
  usedUnits?: number;
}

export interface SlotPolicy {
  /** 슬롯 시작(분, 하루 기준). 기본 0 */
  startMinute?: number;
  /** 슬롯 끝(분, 하루 기준). 기본 1440. start > end면 자정을 넘는 구간 */
  endMinute?: number;
  /** 두 발행 사이 최소 간격(ms). 기본 0 */
  minGapMs?: number;
  /** 분 계산에 쓸 시간대 오프셋(분). 기본 0(UTC) */
  timeZoneOffsetMinutes?: number;
}

export interface QuotaPlannerInput {
  provider: ProviderId;
  nowMs: number;
  budget: BudgetWindow;
  jobs: readonly PublishJobRequest[];
  slot?: SlotPolicy;
  /** 계획을 세울 최대 창 수. 기본 14 */
  maxWindows?: number;
}

export type PlanReason = 'preferred' | 'slot-shifted' | 'gap-shifted' | 'quota-shifted';

export interface PlannedPublish {
  jobId: string;
  publishAtMs: number;
  /** 0부터 시작하는 창 번호 */
  windowIndex: number;
  units: number;
  /** 희망 시각 대비 지연 */
  delayMs: number;
  /** 왜 이 시각인가. 여러 제약이 겹치면 가장 강한 사유 하나만 남긴다(quota > gap > slot) */
  reason: PlanReason;
}

export type DeferReason = 'quota-exhausted';

export interface DeferredJob {
  jobId: string;
  reason: DeferReason;
  /** 이 시각 이후에는 자리가 생긴다. 계획 지평을 넘어 알 수 없으면 null */
  earliestAtMs: number | null;
}

export interface PlannedWindow {
  index: number;
  startMs: number;
  endMs: number;
  capacityUnits: number;
  plannedUnits: number;
  jobs: number;
}

export interface QuotaPlan {
  provider: ProviderId;
  nowMs: number;
  windowMs: number;
  assignments: PlannedPublish[];
  deferred: DeferredJob[];
  windows: PlannedWindow[];
}

interface ResolvedSlot {
  start: number;
  end: number;
  minGapMs: number;
  offsetMs: number;
  enabled: boolean;
}

interface WindowState extends PlannedWindow {
  remainingUnits: number;
}

function resolveSlot(slot: SlotPolicy | undefined): ResolvedSlot {
  const start = Math.trunc(slot?.startMinute ?? 0);
  const end = Math.trunc(slot?.endMinute ?? DAY_MINUTES);
  const minGapMs = slot?.minGapMs ?? 0;
  if (start < 0 || start > DAY_MINUTES || end < 0 || end > DAY_MINUTES || start === end) {
    throw new ShortformError('slot window is invalid', {
      code: 'VALIDATION',
      details: { startMinute: start, endMinute: end },
    });
  }
  if (!Number.isFinite(minGapMs) || minGapMs < 0) {
    throw new ShortformError('minGapMs must be >= 0', { code: 'VALIDATION', details: { minGapMs } });
  }
  return {
    start,
    end,
    minGapMs,
    offsetMs: Math.trunc(slot?.timeZoneOffsetMinutes ?? 0) * MINUTE_MS,
    enabled: !(start === 0 && end === DAY_MINUTES),
  };
}

function minutesOfDay(ts: number, offsetMs: number): number {
  const local = ts + offsetMs;
  const wrapped = ((local % DAY_MS) + DAY_MS) % DAY_MS;
  return Math.floor(wrapped / MINUTE_MS);
}

function isInsideSlot(ts: number, slot: ResolvedSlot): boolean {
  if (!slot.enabled) return true;
  const minute = minutesOfDay(ts, slot.offsetMs);
  if (slot.start < slot.end) return minute >= slot.start && minute < slot.end;
  // 자정을 넘는 구간(예: 22:00–06:00)
  return minute >= slot.start || minute < slot.end;
}

/** `ts` 이후의 첫 슬롯 시각. 이미 슬롯 안이면 그대로 돌려준다. */
export function nextSlotAtOrAfter(ts: number, slot: ResolvedSlot | undefined): number {
  if (!slot || !slot.enabled) return ts;
  if (isInsideSlot(ts, slot)) return ts;
  const minute = minutesOfDay(ts, slot.offsetMs);
  const dayStart = Math.floor((ts + slot.offsetMs) / DAY_MS) * DAY_MS;
  const beforeOpening = slot.start < slot.end && minute < slot.start;
  const targetMinute = beforeOpening ? slot.start : slot.start + DAY_MINUTES;
  return dayStart + targetMinute * MINUTE_MS - slot.offsetMs;
}

function buildWindows(input: QuotaPlannerInput, windowMs: number): WindowState[] {
  const maxWindows = Math.max(1, Math.trunc(input.maxWindows ?? 14));
  const start0 = input.budget.windowStartMs ?? input.nowMs;
  // 첫 창은 "지금부터 리셋까지"처럼 짧을 수 있다. 두 번째 창부터는 고정 길이다.
  const firstEnd = Math.max(start0 + 1, input.budget.firstWindowEndMs ?? start0 + windowMs);
  const used = Math.max(0, Math.trunc(input.budget.usedUnits ?? 0));
  const windows: WindowState[] = [];
  for (let index = 0; index < maxWindows; index += 1) {
    const startMs = index === 0 ? start0 : firstEnd + (index - 1) * windowMs;
    const endMs = index === 0 ? firstEnd : startMs + windowMs;
    const capacityUnits = index === 0 ? Math.max(0, input.budget.limitUnits - used) : input.budget.limitUnits;
    windows.push({
      index,
      startMs,
      endMs,
      capacityUnits,
      plannedUnits: 0,
      jobs: 0,
      remainingUnits: capacityUnits,
    });
  }
  return windows;
}

function sortJobs(jobs: readonly PublishJobRequest[]): PublishJobRequest[] {
  const seen = new Set<string>();
  for (const job of jobs) {
    if (typeof job.id !== 'string' || job.id.trim() === '') {
      throw new ShortformError('job id is required', { code: 'VALIDATION' });
    }
    if (seen.has(job.id)) {
      throw new ShortformError(`duplicate job id: ${job.id}`, { code: 'VALIDATION', details: { jobId: job.id } });
    }
    seen.add(job.id);
  }
  return [...jobs].sort((left, right) => {
    const byPriority = (right.priority ?? 0) - (left.priority ?? 0);
    if (byPriority !== 0) return byPriority;
    const byPreferred =
      (left.preferredAtMs ?? Number.MAX_SAFE_INTEGER) - (right.preferredAtMs ?? Number.MAX_SAFE_INTEGER);
    if (byPreferred !== 0) return byPreferred;
    return left.id.localeCompare(right.id);
  });
}

function windowAt(windows: WindowState[], ts: number): WindowState | null {
  for (const window of windows) {
    if (ts >= window.startMs && ts < window.endMs) return window;
  }
  return null;
}

/**
 * 발행 계획 수립.
 *
 * `assignments`는 보낼 시각이 정해진 작업, `deferred`는 계획 지평 안에서 자리를 얻지 못한
 * 작업이다. 호출자는 `publishAtMs`를 스케줄러에 등록하고, `deferred`는 "다음 창 이후"로
 * 운영자에게 알리면 된다.
 */
export function planPublishQuota(input: QuotaPlannerInput): QuotaPlan {
  const windowMs = input.budget.windowMs ?? 24 * 60 * MINUTE_MS;
  const unitCost = Math.trunc(input.budget.unitCost);
  if (!Number.isFinite(windowMs) || windowMs <= 0) {
    throw new ShortformError('windowMs must be positive', { code: 'VALIDATION', details: { windowMs } });
  }
  if (!Number.isFinite(unitCost) || unitCost <= 0) {
    throw new ShortformError('unitCost must be positive', { code: 'VALIDATION', details: { unitCost } });
  }
  if (!Number.isFinite(input.budget.limitUnits) || input.budget.limitUnits < 0) {
    throw new ShortformError('limitUnits must be >= 0', {
      code: 'VALIDATION',
      details: { limitUnits: input.budget.limitUnits },
    });
  }
  if (!Number.isFinite(input.nowMs)) {
    throw new ShortformError('nowMs is required', { code: 'VALIDATION' });
  }

  const slot = resolveSlot(input.slot);
  const windows = buildWindows(input, windowMs);
  const jobs = sortJobs(input.jobs);
  const assignments: PlannedPublish[] = [];
  const deferred: DeferredJob[] = [];
  /** 창별로 이미 잡힌 시각(최소 간격 판정용) */
  const takenByWindow = new Map<number, number[]>();

  const defer = (jobId: string, earliestAtMs: number | null): void => {
    deferred.push({ jobId, reason: 'quota-exhausted', earliestAtMs });
  };

  for (const job of jobs) {
    const preferred = Math.max(input.nowMs, job.preferredAtMs ?? input.nowMs, job.notBeforeMs ?? 0);
    let candidate = preferred;
    let reason: PlanReason = 'preferred';
    let guard = 0;

    for (;;) {
      guard += 1;
      if (guard > 5_000) {
        throw new ShortformError('planner did not converge', { code: 'CONFIG', details: { jobId: job.id } });
      }

      const aligned = nextSlotAtOrAfter(candidate, slot);
      if (aligned !== candidate) {
        candidate = aligned;
        if (reason === 'preferred') reason = 'slot-shifted';
      }

      const window = windowAt(windows, candidate);
      if (!window) {
        const next = windows.find((entry) => entry.startMs > candidate);
        defer(job.id, next ? nextSlotAtOrAfter(next.startMs, slot) : null);
        break;
      }

      if (window.remainingUnits < unitCost) {
        const next = windows[window.index + 1];
        if (!next) {
          defer(job.id, null);
          break;
        }
        candidate = next.startMs;
        reason = 'quota-shifted';
        continue;
      }

      const taken = takenByWindow.get(window.index) ?? [];
      const conflict = taken.find((time) => Math.abs(time - candidate) < slot.minGapMs);
      if (conflict !== undefined) {
        candidate = conflict + slot.minGapMs;
        if (reason === 'preferred' || reason === 'slot-shifted') reason = 'gap-shifted';
        if (candidate >= window.endMs) {
          const next = windows[window.index + 1];
          if (!next) {
            defer(job.id, null);
            break;
          }
          candidate = next.startMs;
          reason = 'quota-shifted';
        }
        continue;
      }

      taken.push(candidate);
      takenByWindow.set(
        window.index,
        taken.sort((left, right) => left - right),
      );
      window.remainingUnits -= unitCost;
      window.plannedUnits += unitCost;
      window.jobs += 1;
      assignments.push({
        jobId: job.id,
        publishAtMs: candidate,
        windowIndex: window.index,
        units: unitCost,
        // 희망 시각이 과거면 0이다(지연이 아니라 잡아당긴 것이므로).
        delayMs: Math.max(0, candidate - Math.max(job.preferredAtMs ?? input.nowMs, input.nowMs)),
        reason,
      });
      break;
    }
  }

  return {
    provider: input.provider,
    nowMs: input.nowMs,
    windowMs,
    assignments: assignments.sort((left, right) => {
      if (left.publishAtMs !== right.publishAtMs) return left.publishAtMs - right.publishAtMs;
      return left.jobId.localeCompare(right.jobId);
    }),
    deferred,
    windows: windows.map(({ index, startMs, endMs, capacityUnits, plannedUnits, jobs: jobCount }) => ({
      index,
      startMs,
      endMs,
      capacityUnits,
      plannedUnits,
      jobs: jobCount,
    })),
  };
}

/**
 * 이미 소비 상태를 아는 제한 결정(`LimitDecision`)에서 계획을 시작한다.
 * `quotaResetInMs`가 다음 창의 시작이 된다.
 */
export function planFromLimitDecision(
  decision: LimitDecision,
  jobs: readonly PublishJobRequest[],
  options: { nowMs: number; windowMs?: number; slot?: SlotPolicy; maxWindows?: number; unitCost?: number },
): QuotaPlan {
  return planPublishQuota({
    provider: decision.provider,
    nowMs: options.nowMs,
    budget: {
      limitUnits: decision.quotaLimit,
      unitCost: options.unitCost ?? 1,
      usedUnits: Math.max(0, decision.quotaLimit - decision.quotaRemaining),
      windowMs: options.windowMs,
      windowStartMs: options.nowMs,
      firstWindowEndMs: options.nowMs + Math.max(0, decision.quotaResetInMs),
    },
    jobs,
    slot: options.slot,
    maxWindows: options.maxWindows,
  });
}

/** 콘솔 스냅숏(테넌트×플랫폼)에서 바로 계획을 세운다. */
export function planFromTenantView(
  view: TenantLimitView,
  provider: ProviderId,
  jobs: readonly PublishJobRequest[],
  options: { nowMs: number; windowMs?: number; slot?: SlotPolicy; maxWindows?: number; unitCost?: number },
): QuotaPlan {
  const limits = view.providers.find((entry) => entry.provider === provider);
  if (!limits) {
    throw new ShortformError(`provider ${provider} is not tracked for tenant ${view.tenantId}`, {
      code: 'VALIDATION',
      details: { tenantId: view.tenantId, provider },
    });
  }
  return planPublishQuota({
    provider,
    nowMs: options.nowMs,
    budget: {
      limitUnits: limits.quotaLimit,
      unitCost: options.unitCost ?? 1,
      usedUnits: Math.max(0, limits.quotaLimit - limits.quotaRemaining),
      windowMs: options.windowMs,
      windowStartMs: options.nowMs,
      firstWindowEndMs: options.nowMs + Math.max(0, limits.quotaResetInMs),
    },
    jobs,
    slot: options.slot,
    maxWindows: options.maxWindows,
  });
}

export interface PlanSummary {
  planned: number;
  deferred: number;
  totalUnits: number;
  /** 작업이 배치된 창 수 */
  usedWindows: number;
  /** 첫 배치부터 마지막 배치까지의 시간 */
  spanMs: number;
  /** 자리가 있는 창의 예산 소진율(0~1) */
  utilization: number[];
}

export function summarizePlan(plan: QuotaPlan): PlanSummary {
  const usedWindows = plan.windows.filter((window) => window.jobs > 0);
  const first = plan.assignments[0];
  const last = plan.assignments[plan.assignments.length - 1];
  return {
    planned: plan.assignments.length,
    deferred: plan.deferred.length,
    totalUnits: plan.assignments.reduce((sum, assignment) => sum + assignment.units, 0),
    usedWindows: usedWindows.length,
    spanMs: first && last ? Math.max(0, last.publishAtMs - first.publishAtMs) : 0,
    utilization: plan.windows
      .filter((window) => window.capacityUnits > 0)
      .map((window) => Math.round((window.plannedUnits / window.capacityUnits) * 100) / 100),
  };
}
