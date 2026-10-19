/**
 * Production alert for a page over its speed budget (spec 3ef37387 R-31).
 *
 * Reads the same table as the 10x budget tests (./page-budgets.ts, R-40). A
 * page wrapped in `withPageBudget` counts its own Neon round trips and bytes;
 * a load over budget leaves one short-lived `system_cache` row naming the page
 * and its heaviest loader (the `withLoaderLabel` label, or the first app frame,
 * from packages/core/db/query-label.ts). An hourly cron (`/api/cron/page-budget`)
 * reads the trailing hour: a page with `MIN_OVER_LOADS` or more over-budget
 * loads in it is over budget "for an hour", and the operator is told which page
 * and which loader (R-42), at most once a day per page.
 *
 * Rows hold counts, a page name and a loader label, never a user, team, URL or
 * query text. Recording is never load-bearing: a failure here cannot fail a page.
 */
import { and, like, lt } from 'drizzle-orm';
import { db, recordNeonQueries, isRecordingNeonQueries } from '@buildd/core/db';
import { systemCache } from '@buildd/core/db/schema';
import { PAGE_BUDGETS, type Budget, type PageName } from './page-budgets';

export const OVER_KEY_PREFIX = 'page-budget:over:';
export const ALERTED_KEY_PREFIX = 'page-budget:alerted:';
export const WINDOW_MS = 60 * 60 * 1000;
export const ALERT_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** A single slow load is a blip; this many in the hour is a page over budget. */
export const MIN_OVER_LOADS = 3;
const ROW_TTL_MS = 2 * WINDOW_MS;

export interface OverLoad {
  page: PageName;
  queries: number;
  bytes: number;
  /** Heaviest loader in the load: most bytes, then most round trips. */
  loader: string;
  at: number;
}

export function isOverBudget(m: { queries: number; bytes: number }, budget: Budget): boolean {
  return m.queries > budget.queries || m.bytes > budget.bytes;
}

export function heaviestLoader(byLabel: Record<string, { count: number; bytes: number }>): string {
  const entries = Object.entries(byLabel);
  if (!entries.length) return 'unlabelled';
  entries.sort((a, b) => b[1].bytes - a[1].bytes || b[1].count - a[1].count);
  return entries[0][0];
}

/**
 * Run a page's server load and note it when it went over `PAGE_BUDGETS[page]`.
 * Inside a budget test's own recording it only passes through, so the test
 * keeps the queries.
 */
export function withPageBudget<A extends unknown[], R>(
  page: PageName,
  load: (...args: A) => Promise<R>,
): (...args: A) => Promise<R> {
  return async (...args: A) => {
    if (isRecordingNeonQueries()) return load(...args);
    const rec = await recordNeonQueries(() => load(...args));
    if (isOverBudget({ queries: rec.count, bytes: rec.bytes }, PAGE_BUDGETS[page])) {
      void noteOverBudgetLoad({ page, queries: rec.count, bytes: rec.bytes, loader: heaviestLoader(rec.byLabel), at: Date.now() });
    }
    return rec.result;
  };
}

export async function noteOverBudgetLoad(load: OverLoad): Promise<void> {
  try {
    const key = `${OVER_KEY_PREFIX}${load.page}:${load.at}:${Math.random().toString(36).slice(2, 8)}`;
    await db.insert(systemCache).values({
      key,
      value: { queries: load.queries, bytes: load.bytes, loader: load.loader },
      expiresAt: new Date(load.at + ROW_TTL_MS),
    }).onConflictDoNothing();
  } catch (err) {
    console.error('[page-budget] could not record an over-budget load', err);
  }
}

export interface PageBudgetAlert {
  page: PageName;
  loads: number;
  loader: string;
  worstQueries: number;
  worstBytes: number;
  budget: Budget;
}

/** Pages with enough over-budget loads in the window and no alert in the last day. */
export function planPageBudgetAlerts(
  loads: OverLoad[],
  lastAlertedAt: Partial<Record<PageName, number>>,
  now: number,
): PageBudgetAlert[] {
  const byPage = new Map<PageName, OverLoad[]>();
  for (const l of loads) {
    if (l.at < now - WINDOW_MS || !(l.page in PAGE_BUDGETS)) continue;
    byPage.set(l.page, [...(byPage.get(l.page) ?? []), l]);
  }
  const out: PageBudgetAlert[] = [];
  for (const [page, rows] of byPage) {
    if (rows.length < MIN_OVER_LOADS) continue;
    const last = lastAlertedAt[page];
    if (last != null && now - last < ALERT_INTERVAL_MS) continue;
    const counts = new Map<string, number>();
    for (const r of rows) counts.set(r.loader, (counts.get(r.loader) ?? 0) + 1);
    const loader = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
    out.push({
      page,
      loads: rows.length,
      loader,
      worstQueries: Math.max(...rows.map(r => r.queries)),
      worstBytes: Math.max(...rows.map(r => r.bytes)),
      budget: PAGE_BUDGETS[page],
    });
  }
  return out.sort((a, b) => b.loads - a.loads);
}

export function formatPageBudgetAlert(a: PageBudgetAlert): { title: string; message: string } {
  const kb = (n: number) => `${Math.round(n / 1024)} KB`;
  return {
    title: `Page over its speed budget: ${a.page}`,
    message:
      `${a.loads} loads of ${a.page} in the last hour went over budget ` +
      `(worst ${a.worstQueries} queries / ${kb(a.worstBytes)}; budget ${a.budget.queries} / ${kb(a.budget.bytes)}). ` +
      `Heaviest loader: ${a.loader}.`,
  };
}

export async function readOverBudgetLoads(now: number): Promise<OverLoad[]> {
  const rows = await db.select({ key: systemCache.key, value: systemCache.value })
    .from(systemCache)
    .where(like(systemCache.key, `${OVER_KEY_PREFIX}%`));
  const out: OverLoad[] = [];
  for (const r of rows) {
    const [page, at] = r.key.slice(OVER_KEY_PREFIX.length).split(':');
    const v = r.value as { queries?: number; bytes?: number; loader?: string };
    if (!(page in PAGE_BUDGETS) || !Number(at)) continue;
    out.push({ page: page as PageName, at: Number(at), queries: v.queries ?? 0, bytes: v.bytes ?? 0, loader: v.loader ?? 'unlabelled' });
  }
  return out.filter(l => l.at >= now - WINDOW_MS);
}

export async function readLastAlerted(): Promise<Partial<Record<PageName, number>>> {
  const rows = await db.select({ key: systemCache.key, updatedAt: systemCache.updatedAt })
    .from(systemCache)
    .where(like(systemCache.key, `${ALERTED_KEY_PREFIX}%`));
  const out: Partial<Record<PageName, number>> = {};
  for (const r of rows) out[r.key.slice(ALERTED_KEY_PREFIX.length) as PageName] = r.updatedAt.getTime();
  return out;
}

/**
 * Take the day's alert for `page`: true for exactly one caller. The upsert only
 * moves a row that is older than the interval, so a concurrent run gets nothing.
 */
export async function claimPageAlert(page: PageName, now: number): Promise<boolean> {
  const claimed = await db.insert(systemCache)
    .values({ key: `${ALERTED_KEY_PREFIX}${page}`, value: {}, updatedAt: new Date(now) })
    .onConflictDoUpdate({
      target: systemCache.key,
      set: { updatedAt: new Date(now) },
      setWhere: lt(systemCache.updatedAt, new Date(now - ALERT_INTERVAL_MS)),
    })
    .returning({ key: systemCache.key });
  return claimed.length > 0;
}

export async function deleteExpiredLoads(now: number): Promise<void> {
  await db.delete(systemCache).where(and(like(systemCache.key, `${OVER_KEY_PREFIX}%`), lt(systemCache.expiresAt, new Date(now))));
}
