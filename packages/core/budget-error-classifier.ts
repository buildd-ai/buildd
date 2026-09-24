/**
 * Canonical detector for provider usage/budget exhaustion, shared by the web
 * app (worker PATCH -> backend_pauses + failover) and the runner (claim
 * circuit breaker + worker error reporting) so the three call sites can't
 * drift into hand-maintained substring lists that each miss a provider's
 * wording — see the Codex quota-wall incident, where `isBudgetExhaustionError`
 * matched only Claude's phrasing and Codex walls hard-failed instead of
 * pausing/failing over.
 *
 * What counts as exhaustion here is a PROVIDER wall: a pool shared by every
 * task on the credential, with a stated reset time — Claude's OAuth seat cap
 * ("You've hit your session limit · resets 3am (UTC)"), its weekly cap, the
 * extra-usage wall ("out of extra usage"), and Codex's usage wall ("You've hit
 * your usage limit ... try again at 3:45pm.").
 *
 * A per-session dollar cap (the SDK's `maxBudgetUsd`, reported as
 * `error_max_budget_usd` / "Budget limit exceeded") is deliberately NOT one of
 * these. It is a ceiling THIS task hit; nothing else on the credential is out
 * of anything. Treating it as a wall paused the team's backend, flagged every
 * seat exhausted for a session window, wrote a fake pacing episode and failed
 * tasks over to another provider. It is recognised separately by
 * `isSessionBudgetCapError` so callers can fail the one task instead.
 *
 * Patterns are anchored on "hit your <noun> limit" rather than the bare noun
 * ("session limit", "usage limit") wherever the bare noun could plausibly
 * appear in unrelated prose — e.g. a worker reading docs or a changelog that
 * discusses usage limits. ("session limit" is kept bare too, matching prior
 * behaviour, since that phrase does not show up in ordinary prose the way
 * "usage limit" does.)
 */

/** Anchor for Claude's OAuth seat session cap. */
export const CLAUDE_SESSION_LIMIT_PATTERN = 'hit your session';

/** Anchor for Claude's OAuth seat weekly cap ("You've hit your weekly limit · resets 4am (UTC)"). */
export const CLAUDE_WEEKLY_LIMIT_PATTERN = 'hit your weekly';

/** Anchor for Codex's usage/quota wall. */
export const CODEX_USAGE_LIMIT_PATTERN = 'hit your usage limit';

export const BUDGET_EXHAUSTION_PATTERNS: readonly string[] = [
  'out of extra usage',
  CLAUDE_SESSION_LIMIT_PATTERN,
  'session limit',
  CLAUDE_WEEKLY_LIMIT_PATTERN,
  'weekly limit',
  CODEX_USAGE_LIMIT_PATTERN,
];

/**
 * Texts a per-session dollar cap has been reported with. The runner now sends
 * an explicit `sessionBudgetCapped` flag; these remain so a runner that still
 * reports only the text (with the old `budgetExhausted: true`) is classified
 * the same way.
 */
export const SESSION_BUDGET_CAP_PATTERNS: readonly string[] = [
  'error_max_budget_usd',
  'budget limit exceeded',
  'max budget',
  'maxbudgetusd',
];

/**
 * True when a worker error indicates the agent ran into a provider usage wall
 * (session/weekly/extra-usage cap or a Codex quota wall) rather than failing
 * on the task itself. A per-session dollar cap is NOT a match — see
 * `isSessionBudgetCapError`.
 */
export function isBudgetExhaustionError(error?: string | null): boolean {
  if (!error) return false;
  const lower = error.toLowerCase();
  return BUDGET_EXHAUSTION_PATTERNS.some(pattern => lower.includes(pattern));
}

/**
 * True when a worker error is the task's own per-session dollar cap
 * (`maxBudgetUsd`). A task-level failure: nothing about the provider pool is
 * implied.
 */
export function isSessionBudgetCapError(error?: string | null): boolean {
  if (!error) return false;
  const lower = error.toLowerCase();
  return SESSION_BUDGET_CAP_PATTERNS.some(pattern => lower.includes(pattern));
}
