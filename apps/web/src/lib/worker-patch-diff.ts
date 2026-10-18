/**
 * What a worker progress report actually changes (spec 3ef37387 R-33).
 *
 * The runner re-sends its whole view of a live worker every ~10 s: status,
 * current action, the milestone list, branch, local UI URL. Most of those
 * reports change nothing. PATCH /api/workers/[id] builds the write it would
 * make, then keeps only the fields whose value differs from the row it read,
 * and writes nothing at all when none does. Redis records liveness; the
 * durable clock floor is only the fallback when Redis cannot accept a beat.
 */
import * as redis from '@/lib/redis';
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
const NOT_A_CHANGE = new Set(['updatedAt']);

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
 * automatic turn increment), which rides along only when something else is written.
 */
export function changedFields(updates: Record<string, unknown>, row: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined || NOT_A_CHANGE.has(key) || (key === 'turns' && isSqlExpression(value))) continue;
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

/** Worker activity stays separate from runner/session beats (PR #5166 key convention). */
const workerBeatKey = (id: string) => `buildd:live:worker:${id}`;
// Keep the stamp beyond every worker reap window: readers apply their own cutoff.
const WORKER_BEAT_TTL_SEC = 7 * 24 * 60 * 60;
const workerRedis = redis as Partial<typeof redis> & {
  getKeys?: <T>(keys: readonly string[]) => Promise<Array<T | null> | undefined>;
};

/** True only when Redis accepted the beat; false keeps the durable fallback. */
export async function markWorkerHeartbeat(id: string, now: Date = new Date()): Promise<boolean> {
  try {
    return (await workerRedis.setWithTtl?.(workerBeatKey(id), now.getTime(), WORKER_BEAT_TTL_SEC)) === true;
  } catch { return false; }
}

/** Newer of durable activity and the worker's beat, falling back on Redis failure. */
export async function workerHeartbeatAt(id: string, stored: Date): Promise<Date> {
  try {
    const beat = await workerRedis.getKey?.<number>(workerBeatKey(id));
    return typeof beat === 'number' && Number.isFinite(beat) && beat > stored.getTime()
      ? new Date(beat) : stored;
  } catch { return stored; }
}

/** SQL finds stale candidates; Redis vetoes those whose liveness is still fresh. */
export async function withoutRecentWorkerHeartbeat<T extends { id: string }>(
  rows: T[], cutoff: (row: T) => number,
): Promise<T[]> {
  if (rows.length === 0) return rows;
  try {
    const beats = workerRedis.getKeys
      ? await workerRedis.getKeys<number>(rows.map(row => workerBeatKey(row.id)))
      : await Promise.all(rows.map(row => workerRedis.getKey?.<number>(workerBeatKey(row.id))));
    // Configured Redis that cannot answer is not evidence of death. Keep the
    // worker alive until the liveness store can verify it again. Without Redis
    // configured, PATCH retains its durable clock and the old rules apply.
    if ((!beats || beats.some(v => v === undefined)) && workerRedis.isRedisConfigured?.()) return [];
    return rows.filter((row, i) => {
      const beat = beats?.[i];
      return typeof beat !== 'number' || !Number.isFinite(beat) || beat < cutoff(row);
    });
  } catch {
    return workerRedis.isRedisConfigured?.() ? [] : rows;
  }
}

/** Parked-session polling must never advance the question expiry clock. */
const parkedSeenKey = (id: string) => `buildd:live:worker-session:${id}`;
export async function markParkedWorkerSeen(id: string, now: Date = new Date()): Promise<boolean> {
  try {
    return (await workerRedis.setWithTtl?.(parkedSeenKey(id), now.getTime(), WORKER_BEAT_TTL_SEC)) === true;
  } catch { return false; }
}
export async function parkedWorkerSeenAt(id: string, stored: string | Date | null): Promise<string | Date | null> {
  try {
    const beat = await workerRedis.getKey?.<number>(parkedSeenKey(id));
    const storedMs = stored === null ? 0 : new Date(stored).getTime();
    return typeof beat === 'number' && Number.isFinite(beat) && (!(storedMs > 0) || beat > storedMs)
      ? new Date(beat) : stored;
  } catch { return stored; }
}


/** Keep live candidates even when their durable activity predates the window. */
export async function withRecentWorkerHeartbeat<T extends { id: string; updatedAt: Date }>(rows: T[], cutoff: number): Promise<T[]> {
  const old = rows.filter(row => row.updatedAt?.getTime() < cutoff);
  const dead = new Set((await withoutRecentWorkerHeartbeat(old, () => cutoff)).map(row => row.id));
  return rows.filter(row => !dead.has(row.id));
}
