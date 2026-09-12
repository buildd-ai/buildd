/**
 * Canonical detector for provider usage/budget exhaustion, shared by the web
 * app (worker PATCH -> backend_pauses + failover) and the runner (claim
 * circuit breaker + worker error reporting) so the three call sites can't
 * drift into hand-maintained substring lists that each miss a provider's
 * wording — see the Codex quota-wall incident, where `isBudgetExhaustionError`
 * matched only Claude's phrasing and Codex walls hard-failed instead of
 * pausing/failing over.
 *
 * Two distinct exhaustion families:
 *   - API-key pay-per-token dollar budgets ("budget limit exceeded", "max
 *     budget", "error_max_budget_usd", "out of extra usage").
 *   - Provider session/quota walls with a stated reset time — Claude's OAuth
 *     seat cap ("You've hit your session limit · resets 3am (UTC)") and
 *     Codex's usage wall ("You've hit your usage limit ... try again at
 *     3:45pm.").
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

/** Anchor for Codex's usage/quota wall. */
export const CODEX_USAGE_LIMIT_PATTERN = 'hit your usage limit';

export const BUDGET_EXHAUSTION_PATTERNS: readonly string[] = [
  'budget limit exceeded',
  'out of extra usage',
  'error_max_budget_usd',
  'max budget',
  CLAUDE_SESSION_LIMIT_PATTERN,
  'session limit',
  CODEX_USAGE_LIMIT_PATTERN,
];

/**
 * True when a worker error indicates the agent ran out of provider usage
 * (dollar budget or session/quota cap) rather than failing on the task
 * itself.
 */
export function isBudgetExhaustionError(error?: string | null): boolean {
  if (!error) return false;
  const lower = error.toLowerCase();
  return BUDGET_EXHAUSTION_PATTERNS.some(pattern => lower.includes(pattern));
}
