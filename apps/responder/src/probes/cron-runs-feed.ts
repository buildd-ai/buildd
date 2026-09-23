/**
 * `cron_runs` as a read-only feed.
 *
 * ── Why the responder may read this table at all ────────────────────────────
 * The responder's own state is local and embedded (`evidence.ts`); nothing it
 * remembers goes to a database. This is different: `cron_runs` is an *input*,
 * the place the platform records what its own detectors concluded. Reading it
 * is black-box observation of an outcome, which is the one category of
 * production access the design permits. Writing to it is not permitted at all
 * — `alerted_at` belongs to `withCronRun`, and a second writer would corrupt
 * the cron health check's own dedupe.
 *
 * That rule is enforced by shape, not by intent: this module exposes exactly
 * one SQL string, it is a bare SELECT, and its test asserts that no mutating
 * verb appears anywhere in it.
 *
 * ── Why the neon HTTP driver ────────────────────────────────────────────────
 * Direct `psql` to Neon times out from outside the platform (5432 is not
 * reachable), so the only workable path is the same HTTPS one the app uses.
 * `@buildd/core/db` is not an option and never will be: it is marked
 * `server-only`, so importing it outside the Next app throws at module load.
 * That is the point of taking a connection string and a `neon()` client here
 * instead — no shared fate with the web app's module graph.
 */

import type { CronRunRow } from '../types';

/**
 * The only statement this app issues against production.
 *
 * `$1` is the window start and `$2` the row cap; both bound, never
 * interpolated. Ordered newest-first in SQL so the cap keeps the newest rows,
 * then reversed in `readCronRuns` so callers walk oldest-first.
 */
export const CRON_RUNS_QUERY = `select job, started_at, finished_at, ok, processed, changed, errors, result, alerted_at
from cron_runs
where started_at >= $1
order by started_at desc
limit $2`;

/** Minimal shape of a parameterized query function, so tests can supply one. */
export type QueryFn = (sql: string, params: unknown[]) => Promise<Record<string, unknown>[]>;

function iso(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function nullableInt(value: unknown): number | null {
  // Null stays null. A null counter means "the route reported nothing", which
  // is not the same claim as "the route found zero" — the fleet-idle detector's
  // `changed` counts problems found, so conflating the two would turn "I have
  // no verdict" into "all clear".
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function normalizeCronRunRow(raw: Record<string, unknown>): CronRunRow {
  return {
    job: String(raw.job ?? ''),
    started_at: iso(raw.started_at) ?? new Date(0).toISOString(),
    finished_at: iso(raw.finished_at),
    ok: raw.ok === true,
    processed: nullableInt(raw.processed),
    changed: nullableInt(raw.changed),
    errors: nullableInt(raw.errors),
    result:
      raw.result && typeof raw.result === 'object'
        ? (raw.result as Record<string, unknown>)
        : null,
    alerted_at: iso(raw.alerted_at),
  };
}

export async function readCronRuns(
  query: QueryFn,
  opts: { sinceIso: string; limit: number },
): Promise<CronRunRow[]> {
  const rows = await query(CRON_RUNS_QUERY, [opts.sinceIso, opts.limit]);
  return rows.map(normalizeCronRunRow).reverse();
}

/**
 * Build a `QueryFn` over the neon HTTP driver.
 *
 * Imported lazily so that a responder configured without a feed never loads
 * the driver at all, and so the detector tests can run in an environment that
 * has no database anything.
 */
export async function neonQueryFn(connectionString: string): Promise<QueryFn> {
  const { neon } = await import('@neondatabase/serverless');
  const sql = neon(connectionString);
  return async (text, params) =>
    (await sql.query(text, params)) as unknown as Record<string, unknown>[];
}
