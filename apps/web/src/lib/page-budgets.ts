/**
 * Per-page budgets: the spec's table, R-1..R-8 (ready time, queries, database data).
 *
 * The one table both readers use (spec 3ef37387 R-40): the 10x budget tests in
 * apps/web/tests/db (queries, bytes) and the production alert in
 * ./page-budget-watch.ts (all three). No other copy of these numbers exists:
 * the Axiom p90 monitor that hard-coded the ready times was retired for that
 * reason (docs/observability-and-notifications.md, "Page speed alert").
 */
export const PAGE_BUDGETS = {
  home: { readyMs: 1000, queries: 15, bytes: 200 * 1024 },
  missionsList: { readyMs: 1000, queries: 10, bytes: 200 * 1024 },
  missionPage: { readyMs: 1200, queries: 20, bytes: 300 * 1024 },
  activity: { readyMs: 1000, queries: 10, bytes: 200 * 1024 },
  taskPage: { readyMs: 1000, queries: 15, bytes: 150 * 1024 },
  health: { readyMs: 1000, queries: 15, bytes: 200 * 1024 },
  specs: { readyMs: 1000, queries: 15, bytes: 200 * 1024 },
  other: { readyMs: 1500, queries: 25, bytes: 300 * 1024 },
} as const;

export type PageName = keyof typeof PAGE_BUDGETS;
/** `readyMs` is a page's; scheduled-job and API budgets in the harness have none. */
export type Budget = { readyMs?: number; queries: number; bytes: number };
