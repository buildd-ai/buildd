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
 * Length of an OAuth seat session window. Doubles as the fallback freeze
 * duration when the reset time cannot be read out of the error string, and as
 * the plausibility bound in `extractResetTime` — a reset cannot legitimately be
 * further away than one whole window.
 */
export const SESSION_WINDOW_MS = 5 * 60 * 60 * 1000;

/** Timezone labels we are willing to treat as UTC. */
const UTC_ZONE_LABELS = new Set(['utc', 'gmt', 'z', 'utc+0', 'gmt+0', 'utc+00', 'gmt+00']);

/**
 * Matches the reset clause inside a session-limit error, e.g.
 * "… · resets 11:10am (UTC)" or "… · resets 3am (UTC)".
 *
 * The time and the (optional) timezone are captured separately so the timezone
 * can actually be honoured — an earlier version captured it and dropped it,
 * which would have read a non-UTC reset as UTC.
 */
const RESET_CLAUSE = /resets\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\s*(?:\(([^)]+)\))?/i;

/** Matches a bare time: "3am", "11:10am", "23:45", "9". */
const TIME_OF_DAY = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/;

export interface ParseResetTimeOptions {
  /**
   * Timezone label as reported by the agent. UTC (or an equivalent label) is
   * honoured; anything else returns null rather than being silently misread.
   * When omitted or empty, UTC is assumed — that is the only form the Claude
   * Agent SDK is known to emit.
   */
  timezone?: string | null;
  /** Reference point for "today" and the past-time rollover. Defaults to now. */
  now?: Date;
}

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
 * Parse a reset time like "5pm", "11:10am" or "23:45" into the next UTC Date at
 * which that clock time occurs. Returns null when the input is unparseable, out
 * of range, or stated in a timezone we refuse to guess at.
 *
 * Minutes matter: Claude reports "resets 11:10am (UTC)", and an hours-only
 * parser silently discards the ":10", pushing callers onto a blanket 5h freeze.
 */
export function parseResetTime(timeStr: string, options: ParseResetTimeOptions = {}): Date | null {
  if (typeof timeStr !== 'string') return null;
  const { timezone, now = new Date() } = options;

  // Refuse to guess at a non-UTC reset rather than misreport it as UTC.
  if (timezone != null) {
    const label = timezone.trim().toLowerCase();
    if (label !== '' && !UTC_ZONE_LABELS.has(label)) return null;
  }

  const match = timeStr.trim().toLowerCase().match(TIME_OF_DAY);
  if (!match) return null;

  let hour = Number.parseInt(match[1], 10);
  const minute = match[2] === undefined ? 0 : Number.parseInt(match[2], 10);
  const meridiem = match[3];

  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  if (minute > 59) return null;

  if (meridiem) {
    // A 12-hour clock reading outside 1..12 is nonsense ("13pm").
    if (hour < 1 || hour > 12) return null;
    if (meridiem === 'pm' && hour < 12) hour += 12;
    if (meridiem === 'am' && hour === 12) hour = 0;
  } else if (hour > 23) {
    // Date.UTC would happily absorb hour 25 into the following day.
    return null;
  }

  const reset = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    hour, minute, 0, 0,
  ));
  // If the reset time already passed today, it means tomorrow.
  if (reset.getTime() <= now.getTime()) {
    reset.setUTCDate(reset.getUTCDate() + 1);
  }
  return reset;
}

/**
 * Pull the reset time out of a session-limit error string. Returns null when
 * there is no reset clause or it cannot be parsed.
 *
 * A session window is `SESSION_WINDOW_MS` long and the error is raised *during*
 * that window, so the reset always lands within one window of the report. When
 * `parseResetTime`'s next-occurrence lands further out than that, the stated
 * time has in fact already passed and the rollover to "tomorrow" overshot — so
 * step back a day and return the occurrence that already happened.
 *
 * Returning a past Date is deliberate and is the whole point of this function:
 * a reset in the past means the session has already reset, so the caller writes
 * an already-elapsed `budgetResetsAt`, the claim gate reads `now >=
 * budgetResetsAt` and clears the flag, and no freeze is served. The old code
 * rolled forward instead and froze claims for up to ~19h.
 */
export function extractResetTime(
  error: string | null | undefined,
  options: { now?: Date } = {},
): Date | null {
  if (typeof error !== 'string' || error.trim() === '') return null;
  const { now = new Date() } = options;

  const match = error.match(RESET_CLAUSE);
  if (!match) return null;

  const reset = parseResetTime(match[1], { now, timezone: match[2] ?? null });
  if (!reset) return null;

  // parseResetTime always returns the next occurrence. If that is more than one
  // window away the clock time already went by, so the previous occurrence is
  // the real one. It is necessarily <= now, since `reset` was the first
  // occurrence after now.
  if (reset.getTime() - now.getTime() > SESSION_WINDOW_MS) {
    return new Date(reset.getTime() - 24 * 60 * 60 * 1000);
  }
  return reset;
}
