// Detection + parsing for agent usage/budget exhaustion.
//
// Two distinct exhaustion modes surface here as worker error strings:
//   1. API-key pay-per-token budgets ("budget limit exceeded", "max budget",
//      "error_max_budget_usd", "out of extra usage").
//   2. OAuth seat session caps — the Claude Agent SDK throws
//      "Claude Code returned an error result: You've hit your session limit ·
//      resets 3am (UTC)". Once the seat session is capped the token is also
//      invalidated, so every subsequent claim fails with "Not logged in".
//
// Both must be recognised as exhaustion so the worker route flags the account
// budget (stopping the claim route from re-handing Claude tasks that would
// instantly fail) and re-queues the task — optionally failing over to Codex.

/**
 * True when a worker error indicates the agent ran out of usage (dollar budget
 * or OAuth session cap) rather than failing on the task itself.
 */
export function isBudgetExhaustionError(error?: string | null): boolean {
  if (!error) return false;
  const lower = error.toLowerCase();
  return (
    lower.includes('budget limit exceeded') ||
    lower.includes('out of extra usage') ||
    lower.includes('error_max_budget_usd') ||
    lower.includes('max budget') ||
    // OAuth seat session cap (e.g. "You've hit your session limit · resets 3am (UTC)")
    lower.includes('session limit') ||
    lower.includes('hit your session')
  );
}

/**
 * Parse a reset time like "5pm" (UTC) into a Date. Returns null if unparseable.
 */
export function parseResetTime(timeStr: string): Date | null {
  const match = timeStr.match(/^(\d{1,2})(am|pm)?$/i);
  if (!match) return null;

  let hour = parseInt(match[1], 10);
  const ampm = match[2]?.toLowerCase();
  if (ampm === 'pm' && hour < 12) hour += 12;
  if (ampm === 'am' && hour === 12) hour = 0;

  const now = new Date();
  const reset = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    hour, 0, 0, 0,
  ));
  // If the reset time is in the past today, it means tomorrow
  if (reset.getTime() <= now.getTime()) {
    reset.setUTCDate(reset.getUTCDate() + 1);
  }
  return reset;
}
