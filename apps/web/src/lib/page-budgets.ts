/**
 * Per-page budgets: the spec's table, R-1..R-8 (queries, database data).
 *
 * The one table both readers use (spec 3ef37387 R-40): the 10x budget tests in
 * apps/web/tests/db and the production alert in ./page-budget-watch.ts.
 */
export const PAGE_BUDGETS = {
  home: { queries: 15, bytes: 200 * 1024 },
  missionsList: { queries: 10, bytes: 200 * 1024 },
  missionPage: { queries: 20, bytes: 300 * 1024 },
  activity: { queries: 10, bytes: 200 * 1024 },
  taskPage: { queries: 15, bytes: 150 * 1024 },
  health: { queries: 15, bytes: 200 * 1024 },
  specs: { queries: 15, bytes: 200 * 1024 },
  other: { queries: 25, bytes: 300 * 1024 },
} as const;

export type PageName = keyof typeof PAGE_BUDGETS;
export type Budget = { queries: number; bytes: number };
