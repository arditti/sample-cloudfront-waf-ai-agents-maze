// AI Maze — per-context failure backoff.
//
// Pure and dependency-free so it can be exercised without AWS.
//
// Some sources can never produce a decoy: a favicon, an asset with no decoy
// archetype, a login wall, a page the validator keeps refusing. Nothing about that
// stops a crawler asking for them. The edge logs `decoy_needed` on every request,
// the parser collapses duplicates only inside a 5-minute window, and each enqueued
// message is retried up to `maxReceiveCount` times — so one doomed path costs a
// fetch, a headless render and several model calls, over and over, for as long as
// anything keeps crawling it. Worse, which paths get crawled is the adversary's
// choice, so this is an attacker-controlled bill.
//
// The fix is state, not a bigger dedup window: remember that a context just failed
// and refuse to spend anything on it again until its backoff has elapsed. Failures
// are counted on the context POINTER, so the memory survives the queue, the
// container and the DLQ.
//
// The DLQ therefore stays mostly empty by design — a suppressed attempt is a
// success from SQS's point of view. The record of failing contexts is the pointer
// itself (`failCount`, `lastFailAt`, `lastFailReason`), which is more useful: it is
// queryable per context and carries the reason (scan the snapshot table for
// `failCount` in the DynamoDB console).

/**
 * Delay before a context that has failed `failCount` times may be attempted again.
 * Steps rather than a formula, so the progression is obvious when reading a log:
 * five minutes, a quarter hour, an hour, six hours, then a day for anything that
 * keeps failing. A source broken for a day is broken; checking it more often buys
 * nothing.
 */
export const BACKOFF_STEPS_SECONDS = [300, 900, 3600, 21600, 86400];

export function backoffSeconds(failCount) {
  const n = Number(failCount) || 0;
  if (n <= 0) return 0;
  return BACKOFF_STEPS_SECONDS[Math.min(n, BACKOFF_STEPS_SECONDS.length) - 1];
}

/**
 * Seconds still to wait before this context may be attempted, or 0 when it is free
 * to run. A pointer with no failure history is always free.
 *
 * @param {{failCount?: number, lastFailAt?: number}|null} pointer context POINTER item
 * @param {number} nowSec current epoch seconds
 */
export function suppressedFor(pointer, nowSec) {
  const failCount = Number(pointer?.failCount) || 0;
  const lastFailAt = Number(pointer?.lastFailAt) || 0;
  if (!failCount || !lastFailAt) return 0;
  const wait = backoffSeconds(failCount);
  const elapsed = Math.max(0, Number(nowSec) - lastFailAt);
  return elapsed >= wait ? 0 : wait - elapsed;
}

/** Human-readable delay for log lines. */
export function describeDelay(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}
