import { db } from '@buildd/core/db';
import { sql } from 'drizzle-orm';
import { utcDay } from '@/lib/active-days';

/**
 * Signups, DAU and MAU for the platform-owner admin API (GET /api/admin/growth),
 * read from users.created_at and user_active_days (written by
 * lib/active-days.ts). Activity history starts when that table shipped;
 * nothing is backfilled.
 */

export const SERIES_DAYS = 90;

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
