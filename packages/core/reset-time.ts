/**
 * The single parser for provider-quoted reset times.
 *
 * Providers announce exhaustion with a clock time and nothing else: Claude says
 * "You've hit your session limit · resets 11:10am (UTC)", Codex says "You've
 * hit your usage limit. Upgrade to Pro ... or try again at 3:45 pm." Two
 * consumers need that instant — the web worker route (to write
 * `accounts.budget_resets_at`) and the runner's claim circuit breaker (to size
 * a claim pause) — and they used to each carry their own regexes.
 *
 * The runner's copy was the worse one and it cost an incident: its meridiem
 * group sat flush against the digits, so a *spaced* meridiem ("10:58 pm")
 * captured only "10:58"; the caller then stripped ":58" and resolved a bare
 * hour 10 to 10:00 the next morning. A reset that had already gone by became a
 * ~24h pause on every claim for that auth context. Hence: one parser, here,
 * and no reset regex anywhere else.
 *
 * Pure module — no DB, no env, no `server-only`. It is imported by both the
 * Next.js app and the Bun runner.
 */

/**
 * Length of an OAuth seat session window. Doubles as the fallback freeze
 * duration when the reset time cannot be read out of the error string, and as
 * the default plausibility bound in `extractResetTime` — a seat reset cannot
 * legitimately be further away than one whole window.
 */
export const SESSION_WINDOW_MS = 5 * 60 * 60 * 1000;

/** Shortest pause worth serving: below this the breaker just re-trips. */
export const PAUSE_FLOOR_MS = 5 * 60 * 1000;

/** Longest pause any single provider error may buy. */
export const PAUSE_CEILING_MS = 24 * 60 * 60 * 1000;

/**
 * A clock time with no date is ambiguous by at most 12 hours in each
 * direction, so the occurrence the provider meant is always the one nearest to
 * the report. Used as the plausibility bound when sizing a pause, where —
 * unlike a Claude seat reset — the window length is not known in advance
 * (Codex quota walls quote resets well beyond five hours).
 */
export const NEAREST_OCCURRENCE_WINDOW_MS = 12 * 60 * 60 * 1000;

/** Timezone labels we are willing to treat as UTC. */
const UTC_ZONE_LABELS = new Set(['utc', 'gmt', 'z', 'utc+0', 'gmt+0', 'utc+00', 'gmt+00']);

/**
 * Matches the reset clause inside a session-limit or quota-wall error, e.g.
 * "… · resets 11:10am (UTC)" (Claude) or "… or try again at 3:45 pm." (Codex).
 *
 * Two details are load-bearing:
 *   - `\s*` before `(?:am|pm)` — providers emit both "8:20pm" and "8:20 pm",
 *     and a meridiem lost to a missing space is a reset read 12 hours wrong.
 *   - `(?::\d{2})?` inside the captured group — minutes are part of the time,
 *     not decoration to be stripped by the caller.
 *
 * The time and the (optional) timezone are captured separately so the timezone
 * can actually be honoured — an earlier version captured it and dropped it,
 * which would have read a non-UTC reset as UTC.
 */
const RESET_CLAUSE = /(?:resets|try again at)\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\s*(?:\(([^)]+)\))?/i;

/** Matches a bare time: "3am", "11:10am", "11:10 am", "23:45", "9". */
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

/** The reset clause as the provider wrote it, for logs and labels. */
export interface ResetClause {
  /** Time as written, whitespace-normalised: "10:58 pm", "8:20pm", "3am". */
  time: string;
  /** Timezone label as written, or null when the provider stated none. */
  timezone: string | null;
}

/**
 * Locate the reset clause in an error string without interpreting it.
 *
 * Exists so callers can put the provider's own wording in a label or log line
 * without re-deriving a regex — the runner used to hand-roll one per branch,
 * which is how three slightly different (and two outright broken) copies came
 * to exist.
 */
export function matchResetClause(error: string | null | undefined): ResetClause | null {
  if (typeof error !== 'string') return null;
  const match = error.match(RESET_CLAUSE);
  if (!match) return null;
  return {
    time: match[1].trim().replace(/\s+/g, ' '),
    timezone: match[2] ? match[2].trim() : null,
  };
}

/**
 * Parse a reset time like "5pm", "11:10am", "10:58 pm" or "23:45" into the next
 * UTC Date at which that clock time occurs. Returns null when the input is
 * unparseable, out of range, or stated in a timezone we refuse to guess at.
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

export interface ExtractResetTimeOptions {
  /** Reference point for "today" and the past-time rollover. Defaults to now. */
  now?: Date;
  /**
   * How far ahead a reset may plausibly sit before the stated clock time is
   * read as the occurrence that already went by. Defaults to one seat-session
   * window; pause sizing passes `NEAREST_OCCURRENCE_WINDOW_MS` instead, since
   * a quota wall's window length is not known up front.
   */
  maxAheadMs?: number;
}

/**
 * Pull the reset time out of a session-limit or quota-wall error string.
 * Returns null when there is no reset clause or it cannot be parsed.
 *
 * A seat session window is `SESSION_WINDOW_MS` long and the error is raised
 * *during* that window, so the reset always lands within one window of the
 * report. When `parseResetTime`'s next-occurrence lands further out than
 * `maxAheadMs`, the stated time has in fact already passed and the rollover to
 * "tomorrow" overshot — so step back a day and return the occurrence that
 * already happened.
 *
 * Returning a past Date is deliberate and is the whole point of this function:
 * a reset in the past means the session has already reset, so the caller writes
 * an already-elapsed `budgetResetsAt`, the claim gate reads `now >=
 * budgetResetsAt` and clears the flag, and no freeze is served. The old code
 * rolled forward instead and froze claims for up to ~19h.
 */
export function extractResetTime(
  error: string | null | undefined,
  options: ExtractResetTimeOptions = {},
): Date | null {
  if (typeof error !== 'string' || error.trim() === '') return null;
  const { now = new Date(), maxAheadMs = SESSION_WINDOW_MS } = options;

  const clause = matchResetClause(error);
  if (!clause) return null;

  const reset = parseResetTime(clause.time, { now, timezone: clause.timezone });
  if (!reset) return null;

  // parseResetTime always returns the next occurrence. If that is further out
  // than plausible the clock time already went by, so the previous occurrence
  // is the real one. It is necessarily <= now, since `reset` was the first
  // occurrence after now.
  if (reset.getTime() - now.getTime() > maxAheadMs) {
    return new Date(reset.getTime() - 24 * 60 * 60 * 1000);
  }
  return reset;
}

export interface ResetDelayOptions {
  /** Reference point. Defaults to now. */
  now?: Date;
  /** Shortest pause to return. Defaults to `PAUSE_FLOOR_MS`. */
  floorMs?: number;
  /** Longest pause to return. Defaults to `PAUSE_CEILING_MS`. */
  ceilingMs?: number;
}

/**
 * How long to wait, in ms, for the reset the error text itself quoted —
 * clamped to [floorMs, ceilingMs].
 *
 * `null` means "this text quotes no reset time I can read", which the caller
 * must answer with its own visible default. That distinction is the point: the
 * predecessor (`parseResetDelay`) returned a silent 1 hour for unparseable
 * input, so a caller could not tell a provider that said "one hour" from a
 * provider it had failed to understand.
 *
 * A reset already in the past collapses to `floorMs` rather than rolling
 * forward a day — the wall is over, so claiming should resume.
 */
export function resetDelayMsFrom(
  error: string | null | undefined,
  options: ResetDelayOptions = {},
): number | null {
  const {
    now = new Date(),
    floorMs = PAUSE_FLOOR_MS,
    ceilingMs = PAUSE_CEILING_MS,
  } = options;

  const reset = extractResetTime(error, { now, maxAheadMs: NEAREST_OCCURRENCE_WINDOW_MS });
  if (!reset) return null;

  return Math.max(floorMs, Math.min(reset.getTime() - now.getTime(), ceilingMs));
}

export interface ClampedPause {
  /** The pause to actually serve. */
  pauseMs: number;
  /** The rejected value when a clamp happened, else null. Log it loudly. */
  clampedFromMs: number | null;
}

/**
 * Enforce the invariant this module exists for: **a pause derived from provider
 * text must never outlast the reset instant that text quoted.**
 *
 * Applied to every classification, not just the ones that read the reset
 * clause. A pause computed from the clause satisfies it by construction, so
 * this is a post-condition: it catches a future branch that reintroduces its
 * own arithmetic, and it bounds the flat per-branch defaults (billing, auth,
 * rate limit) that never consult the clause at all. When the text quotes no
 * readable reset there is nothing to bound against and the caller's value
 * stands.
 */
export function clampPauseToQuotedReset(
  error: string | null | undefined,
  pauseMs: number,
  options: ResetDelayOptions = {},
): ClampedPause {
  const allowed = resetDelayMsFrom(error, options);
  if (allowed === null || pauseMs <= allowed) return { pauseMs, clampedFromMs: null };
  return { pauseMs: allowed, clampedFromMs: pauseMs };
}
