import type { RetryPolicy } from '../../types/queue';

export type BackoffPolicy = Pick<RetryPolicy, 'baseDelayMs' | 'maxDelayMs' | 'jitterRatio'>;

/**
 * Delay before retry number `attempt` (1 = the first retry).
 *
 * Deterministic with `jitterRatio: 0`, which is what the queue logs and what
 * the tests pin: 1s → 2s → 4s. With jitter, the delay is drawn from the upper
 * half of the window (`ceiling - spread .. ceiling`), never from zero: a
 * zero-delay retry against a 429 only deepens the ban.
 */
export function computeRetryDelay(
  attempt: number,
  policy: BackoffPolicy,
  random: () => number = Math.random,
): number {
  const safeAttempt = Math.max(1, Math.floor(attempt));
  const exponential = policy.baseDelayMs * 2 ** (safeAttempt - 1);
  const ceiling = Math.min(Math.max(exponential, 0), Math.max(policy.maxDelayMs, policy.baseDelayMs));
  const ratio = Math.min(1, Math.max(0, policy.jitterRatio));
  if (ratio === 0) return Math.round(ceiling);
  const spread = ceiling * ratio;
  return Math.round(ceiling - spread + random() * spread);
}

/** Total wall-clock a policy can spend sleeping across all retries. */
export function maxRetryBudgetMs(policy: BackoffPolicy & { maxAttempts: number }): number {
  let total = 0;
  for (let attempt = 1; attempt < policy.maxAttempts; attempt += 1) {
    total += computeRetryDelay(attempt, { ...policy, jitterRatio: 0 });
  }
  return total;
}
