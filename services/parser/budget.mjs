// AI Maze — generation admission budget (threat model M2).
//
// Pure and dependency-free so it can be exercised without AWS.
//
// Backoff (generator/backoff.mjs) bounds what a *repeated* path can cost, but a
// crawler walking unique paths mints a NEW context per path, and each one is an
// Opus 5 generation. Which paths get crawled is the adversary's choice, so
// without a ceiling the bill is attacker-controlled. The fix is an admission
// budget: at most GEN_BUDGET_PER_WINDOW new contexts may enter generation per
// GEN_BUDGET_WINDOW_SECONDS window, and everything past that is dropped at the
// parser — before the queue, the invoker, the container or the model spend a
// cent. The crawler notices nothing: it keeps receiving the WAF miss directive,
// exactly as it does while a decoy is being generated.
//
// Only FIRST admissions are billed. A rotation regenerates an existing context
// (bounded to one per context per `ttl`), and a retry re-asks for a context that
// already spent its admission (bounded by backoff), so both ride free — the
// unbounded term M2 names is new contexts, and that is the one metered.

export const DEFAULT_BUDGET_PER_WINDOW = 20;
export const DEFAULT_WINDOW_SECONDS = 3600;

/** Start of the budget window containing `nowSec`, aligned so every parser
 * invocation lands on the same window key without coordination. */
export function windowStartSec(nowSec, windowSeconds) {
  const w = Math.max(1, Number(windowSeconds) || DEFAULT_WINDOW_SECONDS);
  const n = Math.max(0, Number(nowSec) || 0);
  return n - (n % w);
}

/** When the window's counter item may be garbage-collected (DynamoDB TTL).
 * One full extra window so an operator can still read the last one. */
export function windowExpiresAt(windowStart, windowSeconds) {
  const w = Math.max(1, Number(windowSeconds) || DEFAULT_WINDOW_SECONDS);
  return windowStart + 2 * w;
}

/**
 * What an ask costs. 'rotation' and 'retry' enqueue without touching the
 * budget; 'new' must win an admission first. An unknown reason is treated as
 * 'new' deliberately: when in doubt, meter it — the failure mode of the maze
 * is an unbounded bill, not a missed decoy.
 *
 * @param {{reason?: string, alreadyAdmitted?: boolean}} ask
 * @returns {'rotation'|'retry'|'new'}
 */
export function classifyAsk({ reason, alreadyAdmitted }) {
  if (reason === 'stale') return 'rotation';
  if (alreadyAdmitted) return 'retry';
  return 'new';
}
