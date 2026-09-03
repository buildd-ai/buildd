/**
 * The worker read behind the CBM rollups. Split from `cbm-insight.ts` so that
 * module stays pure (and client-bundle safe), matching the
 * `usage-stats` / `usage-stats-query` split.
 *
 * Two surfaces now read this — Health's build-health panel and the usage
 * drill-down's adoption line — and they run on DIFFERENT windows (the drill-down
 * clamps 24h to 7d). Sharing the query is what keeps the cohort rules identical
 * while the windows differ.
 */
import { db } from '@buildd/core/db';
import { workers } from '@buildd/core/db/schema';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { aggregateCbm, summarizeCbm, type CbmHealthSummary, type CbmRow } from './cbm-insight';

/** Cap on worker rows scanned per request, matching the usage scan. */
export const CBM_ROW_LIMIT = 5000;

/**
 * CBM health over a window, or null when no completed worker in it recorded CBM
 * metrics at all.
 *
 * Completed workers only, which is load-bearing and not incidental: a failed
 * worker that queried the graph is excluded from BOTH sides of every ratio here.
 * That exclusion is stated at the stat on the drill-down rather than silently
 * absorbed.
 */
export async function fetchCbmSummary(opts: {
  workspaceIds: string[];
  window: string;
  windowStart: Date;
}): Promise<CbmHealthSummary | null> {
  if (opts.workspaceIds.length === 0) return null;

  const rows = await db.query.workers.findMany({
    where: and(
      eq(workers.status, 'completed'),
      sql`${workers.completedAt} >= ${opts.windowStart}`,
      inArray(workers.workspaceId, opts.workspaceIds),
    ),
    columns: { inputTokens: true, resultMeta: true },
    limit: CBM_ROW_LIMIT,
  });

  const cbmRows: CbmRow[] = [];
  for (const r of rows as any[]) {
    const cbm = r.resultMeta?.cbm;
    if (cbm) cbmRows.push({ inputTokens: r.inputTokens ?? 0, cbm });
  }
  if (cbmRows.length === 0) return null;
  return summarizeCbm(aggregateCbm(cbmRows, opts.window, opts.windowStart));
}
