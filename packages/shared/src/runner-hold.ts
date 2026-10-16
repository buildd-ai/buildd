/**
 * A person's hold on a runner (spec "Runner on your terminal", R-32..R-35):
 * `buildd hold` stops the runner choosing new work while what it runs
 * finishes. The runner keeps it in ~/.buildd/config.json and reports it on
 * every heartbeat as `environment.hold`; the server reads it back to refuse
 * broad claims and to show the runner as on hold.
 *
 * Its own state, never the self-update drain's: an update that drains and
 * restarts, or a circuit breaker that resets, never lifts it.
 */

export interface RunnerHold {
  /** ISO time the hold began. */
  since: string;
  /** ISO time it lifts on its own (`buildd hold --for`); null holds until `buildd resume`. */
  until: string | null;
}

function isoOrNull(v: unknown): string | null {
  if (typeof v !== 'string' || !v) return null;
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/** A hold as stored or sent, or null when `raw` is not one (junk is dropped, never half-kept). */
export function parseRunnerHold(raw: unknown): RunnerHold | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const since = isoOrNull(r.since);
  if (!since) return null;
  const until = r.until === null || r.until === undefined ? null : isoOrNull(r.until);
  if (r.until !== null && r.until !== undefined && !until) return null;
  return { since, until };
}

/** True while `hold` is in force at `now`: set, and its `until` (if any) still ahead. */
export function isRunnerHoldActive(hold: RunnerHold | null | undefined, now: number = Date.now()): boolean {
  if (!hold) return false;
  if (!hold.until) return true;
  return Date.parse(hold.until) > now;
}

/** The hold a heartbeat or claim environment carries, only while it is in force. */
export function activeRunnerHold(environment: unknown, now: number = Date.now()): RunnerHold | null {
  if (!environment || typeof environment !== 'object') return null;
  const hold = parseRunnerHold((environment as { hold?: unknown }).hold);
  return isRunnerHoldActive(hold, now) ? hold : null;
}

/**
 * `environment` with its `hold` normalised for storage: a valid hold is kept
 * (as ISO strings), anything else is removed. The same object when it carries
 * no `hold` key.
 */
export function withNormalizedRunnerHold<E>(environment: E): E {
  if (!environment || typeof environment !== 'object' || Array.isArray(environment) || !('hold' in (environment as object))) return environment;
  const { hold: raw, ...rest } = environment as Record<string, unknown>;
  const hold = parseRunnerHold(raw);
  return (hold ? { ...rest, hold } : rest) as E;
}
