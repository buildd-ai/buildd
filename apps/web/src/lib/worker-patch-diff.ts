/**
 * What a worker progress report actually changes (spec 3ef37387 R-33).
 *
 * The runner re-sends its whole view of a live worker every ~10 s: status,
 * current action, the milestone list, branch, local UI URL. Most of those
 * reports change nothing. PATCH /api/workers/[id] builds the write it would
 * make, then keeps only the fields whose value differs from the row it read,
 * and writes nothing at all when none does. `updated_at` still moves on a
 * floor (`livenessWriteDue`), because readers judge a worker's liveness from it.
 */
import { RESUME_RUNNER_FRESH_MS } from '@/lib/answer-resume';

/**
 * The longest a live worker's `updated_at` goes unwritten while its reports
 * change nothing. Every reader that judges liveness from that column uses a
 * window of 10 minutes or more, except the two named below.
 */
export const WORKER_LIVENESS_WRITE_MS = 5 * 60 * 1000;

/**
 * A runner-parked worker (`waiting_input`): `/respond` resumes the session only
 * if `updated_at` is within RESUME_RUNNER_FRESH_MS (lib/answer-resume.ts), so the
 * floor keeps three writes inside that window.
 */
export const PARKED_LIVENESS_WRITE_MS = RESUME_RUNNER_FRESH_MS / 3;

/** An `idle` worker is reaped after 5 minutes without a write (lib/stale-workers.ts): write each minute. */
export const IDLE_LIVENESS_WRITE_MS = 60 * 1000;

/**
 * An interactive session parked on its own question stamps `sessionSeenAt` from
 * its polls; /respond calls it gone after INTERACTIVE_SESSION_POLL_STALE_MS
 * (5 min, lib/answer-resume.ts). Once a minute is enough.
 */
export const INTERACTIVE_SESSION_SEEN_WRITE_MS = 60 * 1000;

/** Fields whose write is bookkeeping of the report itself, never a change by itself. */
const NOT_A_CHANGE = new Set(['updatedAt', 'turns']);

function toTime(v: unknown): number | null {
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'string' || typeof v === 'number') {
    const t = new Date(v).getTime();
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

/** JSON with object keys sorted: Postgres jsonb does not keep key order. */
function canonical(v: unknown): string {
  return JSON.stringify(v, (_k, val) => {
    if (val && typeof val === 'object' && !Array.isArray(val) && !(val instanceof Date)) {
      return Object.fromEntries(Object.keys(val).sort().map(k => [k, (val as Record<string, unknown>)[k]]));
    }
    return val;
  });
}

/** `numeric` columns: written as a string, read back padded ("0.500000" for "0.5"). */
const NUMERIC_COLUMNS = new Set(['costUsd']);

/** A Drizzle SQL expression (an atomic append, an increment): never compared, always written. */
const isSqlExpression = (v: unknown) => !!v && typeof (v as { getSQL?: unknown }).getSQL === 'function';

/** Is `next` (what the report would write) the value the row already holds in `key`? */
export function sameValue(key: string, next: unknown, current: unknown): boolean {
  if (next === undefined || next === null) return current === undefined || current === null;
  if (current === undefined || current === null) return false;
  if (next instanceof Date || current instanceof Date) {
    const a = toTime(next);
    return a !== null && a === toTime(current);
  }
  if (NUMERIC_COLUMNS.has(key)) return Number(next) === Number(current);
  if (typeof next === 'object' || typeof current === 'object') return canonical(next) === canonical(current);
  return next === current;
}

/**
 * The fields of `updates` that change `row`. A SQL expression is always a
 * change, except the per-report bookkeeping in NOT_A_CHANGE (`updated_at`, the
 * turn count), which rides along only when something else is written.
 */
export function changedFields(updates: Record<string, unknown>, row: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined || NOT_A_CHANGE.has(key)) continue;
    if (isSqlExpression(value) || !sameValue(key, value, row[key])) out.push(key);
  }
  return out;
}

/**
 * Owed a liveness write: a report that changes nothing still moves
 * `updated_at` once this worker's floor has passed since the last write.
 */
export function livenessWriteDue(
  row: { status: string | null; updatedAt: Date | string | null },
  nowMs: number = Date.now(),
): boolean {
  const last = toTime(row.updatedAt);
  if (last === null) return true;
  const floor = row.status === 'waiting_input'
    ? PARKED_LIVENESS_WRITE_MS
    : row.status === 'idle'
      ? IDLE_LIVENESS_WRITE_MS
      : WORKER_LIVENESS_WRITE_MS;
  return nowMs - last >= floor;
}
