// Detection + parsing for agent usage/budget exhaustion.
//
// Three distinct exhaustion modes surface here as worker error strings:
//   1. API-key pay-per-token budgets ("budget limit exceeded", "max budget",
//      "error_max_budget_usd", "out of extra usage").
//   2. OAuth seat session caps — the Claude Agent SDK throws
//      "Claude Code returned an error result: You've hit your session limit ·
//      resets 3am (UTC)". Once the seat session is capped the token is also
//      invalidated, so every subsequent claim fails with "Not logged in".
//   3. Codex's usage/quota wall — "You've hit your usage limit. Upgrade to
//      Pro ... or try again at 3:45pm." Unlike Claude, Codex has no
//      redundant signal (no account/tenant budget columns) — this detector
//      is the *only* thing that writes a `backend_pauses` row for Codex, so
//      missing this string means no backstop at all, not just a slower one.
//
// All three must be recognised as exhaustion so the worker route flags the
// right provider pool (stopping the claim route from re-handing tasks that
// would instantly fail) and re-queues the task — optionally failing over to
// the other provider. The detection substrings live in
// @buildd/core/budget-error-classifier so the web route, the runner's claim
// breaker, and the runner's worker-error reporting share one list instead of
// three hand-maintained copies.

// The reset-time parser lives in @buildd/core/reset-time: the runner's claim
// circuit breaker needs the same instant this module needs, and while it kept
// its own copy that copy dropped a spaced meridiem and stripped the minutes,
// turning an already-elapsed reset into a day-long claim pause. Re-exported
// here so this module's existing call sites are unaffected.
import { SESSION_WINDOW_MS } from '@buildd/core/reset-time';

export {
  SESSION_WINDOW_MS,
  parseResetTime,
  extractResetTime,
} from '@buildd/core/reset-time';
export type { ParseResetTimeOptions } from '@buildd/core/reset-time';

/**
 * True when a worker error indicates the agent ran out of usage (dollar
 * budget, OAuth session cap, or a Codex-style quota wall) rather than failing
 * on the task itself. Re-exported for call sites that already import it from
 * here — the canonical pattern list lives in
 * @buildd/core/budget-error-classifier so the runner shares it too.
 */
export { isBudgetExhaustionError } from '@buildd/core/budget-error-classifier';

/** A timestamp as it can arrive from the driver, the API, or code. */
type TimestampLike = Date | string | number | null | undefined;

function toDate(value: TimestampLike): Date | null {
  if (value === null || value === undefined) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isFinite(d.getTime()) ? d : null;
}

/**
 * When an exhausted budget becomes claimable again.
 *
 * `accounts.budget_resets_at` has no `notNull` (it cannot: the column is
 * legitimately NULL for accounts that are not exhausted), so the pairing with
 * `budget_exhausted_at` is a convention held by a single writer. If that pairing
 * is ever broken — a half-applied manual UPDATE, a new writer, a restored
 * backup — the account must recover on its own rather than be parked forever:
 * the claim route's auto-clear required a non-null reset, and its exhaustion test
 * read `!budgetResetsAt ||` as "still exhausted", so NULL meant permanent.
 *
 * A missing or unparseable reset therefore resolves to one session window after
 * the exhaustion instant, which is the same fallback the writer itself uses when
 * the provider error carries no reset time.
 */
export function effectiveBudgetResetAt(
  exhaustedAt: Date | string | number,
  resetsAt: TimestampLike,
): Date {
  const recorded = toDate(resetsAt);
  if (recorded) return recorded;
  const exhausted = toDate(exhaustedAt);
  const base = exhausted ? exhausted.getTime() : Date.now();
  return new Date(base + SESSION_WINDOW_MS);
}

/**
 * Is this account's budget still exhausted right now?
 *
 * False when it was never flagged. Otherwise true until the effective reset —
 * see `effectiveBudgetResetAt` for why a NULL reset is a recoverable fault and
 * not a life sentence.
 */
export function isBudgetExhausted(
  exhaustedAt: TimestampLike,
  resetsAt: TimestampLike,
  now: Date = new Date(),
): boolean {
  const exhausted = toDate(exhaustedAt);
  if (!exhausted) return false;
  return now.getTime() < effectiveBudgetResetAt(exhausted, resetsAt).getTime();
}
