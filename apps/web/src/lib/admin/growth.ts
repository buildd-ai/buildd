import { db } from '@buildd/core/db';
import { sql } from 'drizzle-orm';
import { after } from 'next/server';
import { isUuid } from '@/lib/uuid';

/**
 * Signups, DAU and MAU for the platform-owner admin API (GET /api/admin/growth).
 *
 * Activity is a row in user_active_days per person per UTC day, written the
 * first time that person is seen that day on the dashboard (auth.ts jwt
 * callback) or over MCP with an OAuth session. API keys and task tokens are
 * not people and never reach recordActiveDay. History starts when this
 * shipped; nothing is backfilled.
 */

export type ActiveSurface = 'web' | 'mcp';

export const SERIES_DAYS = 90;

/** UTC calendar day, YYYY-MM-DD. */
export function utcDay(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

// userId -> last UTC day this instance recorded. A duplicate insert from
// another instance is harmless (ON CONFLICT DO NOTHING); this only keeps an
// active person from costing a write per request.
const recorded = new Map<string, string>();
const RECORDED_CAP = 10_000;

/** For tests. */
export function resetActiveDayCache(): void {
  recorded.clear();
}

type Exec = (query: ReturnType<typeof sql>) => Promise<unknown>;
const defaultExec: Exec = (query) => db.execute(query);

/**
 * Note that `userId` was active today. At most one write per person per day
 * per instance. Never throws: activity tracking must not break sign-in or an
 * MCP call.
 */
export async function recordActiveDay(
  userId: string | null | undefined,
  surface: ActiveSurface,
  opts: { now?: Date; exec?: Exec } = {},
): Promise<boolean> {
  if (!isUuid(userId)) return false;
  const day = utcDay(opts.now);
  if (recorded.get(userId) === day) return false;
  if (recorded.size >= RECORDED_CAP) recorded.clear();
  recorded.set(userId, day);
  try {
    await (opts.exec ?? defaultExec)(sql`
      INSERT INTO user_active_days (user_id, day, first_surface)
      VALUES (${userId}::uuid, ${day}::date, ${surface})
      ON CONFLICT (user_id, day) DO NOTHING`);
    return true;
  } catch (err) {
    // Let the next request retry rather than losing the day.
    recorded.delete(userId);
    console.warn('[growth] recording an active day failed:', err instanceof Error ? err.message : err);
    return false;
  }
}

/** recordActiveDay after the response is sent; immediately outside a request scope. */
export function scheduleActiveDay(userId: string | null | undefined, surface: ActiveSurface): void {
  if (!isUuid(userId)) return;
  const run = () => { void recordActiveDay(userId, surface); };
  try {
    after(run);
  } catch {
    run();
  }
}

export interface GrowthDay {
  day: string;
  signups: number;
  dau: number;
  dauWeb: number;
  dauMcp: number;
}

export interface Growth {
  asOf: string;
  totalUsers: number;
  newUsers7d: number;
  dauToday: number;
  wau: number;
  mau: number;
  /** Average DAU over the last 30 days divided by MAU; null with no MAU. */
  dauMauRatio: number | null;
  /** Distinct people by the surface that first recorded each of their days. */
  bySurface: { web: { dau: number; mau: number }; mcp: { dau: number; mau: number } };
  /** First day activity was recorded; null before any. */
  activeSince: string | null;
  days: GrowthDay[];
}

type Row = Record<string, unknown>;
async function rows<T extends Row>(query: ReturnType<typeof sql>): Promise<T[]> {
  const r = await db.execute(query);
  return ((r as { rows?: T[] }).rows ?? []) as T[];
}
const num = (v: unknown) => Number(v ?? 0);

export async function loadGrowth(opts: { now?: Date } = {}): Promise<Growth> {
  const today = utcDay(opts.now);
  const [summary] = await rows<Row>(sql`
    SELECT
      (SELECT count(*) FROM users) AS total_users,
      (SELECT count(*) FROM users
        WHERE created_at >= (${today}::date - 6)::timestamp AT TIME ZONE 'UTC'
          AND created_at < (${today}::date + 1)::timestamp AT TIME ZONE 'UTC') AS new_users_7d,
      count(DISTINCT user_id) FILTER (WHERE day = ${today}::date) AS dau_today,
      count(DISTINCT user_id) FILTER (WHERE day = ${today}::date AND first_surface = 'web') AS dau_web,
      count(DISTINCT user_id) FILTER (WHERE day = ${today}::date AND first_surface = 'mcp') AS dau_mcp,
      count(DISTINCT user_id) FILTER (WHERE day > ${today}::date - 7) AS wau,
      count(DISTINCT user_id) AS mau,
      count(DISTINCT user_id) FILTER (WHERE first_surface = 'web') AS mau_web,
      count(DISTINCT user_id) FILTER (WHERE first_surface = 'mcp') AS mau_mcp,
      count(*)::float / 30 AS avg_dau_30d,
      (SELECT min(day)::text FROM user_active_days) AS active_since
    FROM user_active_days
    WHERE day > ${today}::date - 30 AND day <= ${today}::date`);

  const series = await rows<Row>(sql`
    WITH days AS (
      SELECT generate_series(${today}::date - ${SERIES_DAYS - 1}::int, ${today}::date, interval '1 day')::date AS day
    ),
    signups AS (
      SELECT (created_at AT TIME ZONE 'UTC')::date AS day, count(*) AS n
      FROM users
      WHERE created_at >= (${today}::date - ${SERIES_DAYS - 1}::int)::timestamp AT TIME ZONE 'UTC'
        AND created_at < (${today}::date + 1)::timestamp AT TIME ZONE 'UTC'
      GROUP BY 1
    ),
    active AS (
      SELECT day,
        count(*) AS dau,
        count(*) FILTER (WHERE first_surface = 'web') AS web,
        count(*) FILTER (WHERE first_surface = 'mcp') AS mcp
      FROM user_active_days
      WHERE day > ${today}::date - ${SERIES_DAYS}::int AND day <= ${today}::date
      GROUP BY day
    )
    SELECT d.day::text AS day, coalesce(s.n, 0) AS signups,
      coalesce(a.dau, 0) AS dau, coalesce(a.web, 0) AS web, coalesce(a.mcp, 0) AS mcp
    FROM days d
    LEFT JOIN signups s ON s.day = d.day
    LEFT JOIN active a ON a.day = d.day
    ORDER BY d.day`);

  const mau = num(summary?.mau);
  return {
    asOf: today,
    totalUsers: num(summary?.total_users),
    newUsers7d: num(summary?.new_users_7d),
    dauToday: num(summary?.dau_today),
    wau: num(summary?.wau),
    mau,
    dauMauRatio: mau > 0 ? Math.round((num(summary?.avg_dau_30d) / mau) * 1000) / 1000 : null,
    bySurface: {
      web: { dau: num(summary?.dau_web), mau: num(summary?.mau_web) },
      mcp: { dau: num(summary?.dau_mcp), mau: num(summary?.mau_mcp) },
    },
    activeSince: (summary?.active_since as string | null) ?? null,
    days: series.map(r => ({
      day: String(r.day),
      signups: num(r.signups),
      dau: num(r.dau),
      dauWeb: num(r.web),
      dauMcp: num(r.mcp),
    })),
  };
}
