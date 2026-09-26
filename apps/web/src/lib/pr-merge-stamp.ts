/**
 * A PR's merge belongs to the PR, not to one worker row.
 *
 * Several worker rows can carry the same PR (same `prUrl` + `prNumber`). The
 * common case is a CI-retry or conflict-retry attempt: it pushes to its
 * parent's branch, and when it completes it adopts the PR number. The merge
 * webhook used to stamp `mergedAt` on the one row its `findFirst` returned, so
 * the other rows read as an open PR indefinitely. Home then kept a
 * "Merge PR #N" card for a PR that had already merged.
 *
 * Both halves live here:
 *  - writers (the webhook, and the read-through and cron heal paths) stamp
 *    every unmerged row carrying the PR with `stampPrMergedOnAllRows`;
 *  - readers that list open PRs add `noRowOfPrMerged()`, so a row stamped by
 *    nobody (adopted after the merge, or written before this fix) still counts
 *    as merged when any sibling saw the merge. This matches
 *    `summarizePrShipStates` / `countDistinctPrs` in `@buildd/core/pr-shipped`.
 */
import { and, isNull, sql, type SQL } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { workers } from '@buildd/core/db/schema';
import { workerOwnsPrUrl } from '@/lib/repo-scope';

type WorkerUpdate = Partial<typeof workers.$inferInsert>;

/**
 * Stamp the merge on every row carrying this PR that has not recorded it yet.
 * Idempotent: rows that already carry `mergedAt` keep their original instant.
 * Returns the rows it stamped, so callers can notify their tasks' dependents.
 */
export async function stampPrMergedOnAllRows(input: {
  prUrl: string | null | undefined;
  prNumber: number | null | undefined;
  mergedAt: Date;
  /** Additional columns to write alongside the merge (verification stamps). */
  extra?: WorkerUpdate;
}): Promise<Array<{ id: string; taskId: string | null }>> {
  // Never issue an UPDATE we cannot scope to a real PR identity.
  if (!input.prUrl || input.prNumber == null) return [];
  return db
    .update(workers)
    .set({
      ...input.extra,
      mergedAt: input.mergedAt,
      prLifecycleStatus: 'merged',
      updatedAt: (input.extra?.updatedAt as Date | undefined) ?? new Date(),
    })
    .where(and(workerOwnsPrUrl(input.prUrl, input.prNumber), isNull(workers.mergedAt)))
    .returning({ id: workers.id, taskId: workers.taskId });
}

/**
 * Reader predicate: no row carrying this row's PR has recorded the merge. Add
 * it wherever a query lists open PRs by `isNull(workers.mergedAt)`, which only
 * says that this row did not see the merge.
 *
 * The inner table is aliased by a raw identifier, so the correlated outer
 * references are the only column chunks in it.
 */
/**
 * One row per PR, for surfaces that build one card per PR. The earliest-created
 * row is the PR's owner: it opened the PR, and it is the row the CI webhooks
 * update. A retry row that adopted the PR later carries a stale lifecycle, so
 * letting it win could turn a "CI running" card into a merge request. Rows
 * without a PR pass through. Input order is otherwise kept.
 */
export function oneRowPerPr<T extends { prUrl?: string | null; createdAt?: Date | string | null }>(
  rows: readonly T[],
): T[] {
  const ownerByUrl = new Map<string, T>();
  const at = (r: T) => (r.createdAt ? new Date(r.createdAt).getTime() : Number.POSITIVE_INFINITY);
  for (const r of rows) {
    if (!r.prUrl) continue;
    const prev = ownerByUrl.get(r.prUrl);
    if (!prev || at(r) < at(prev)) ownerByUrl.set(r.prUrl, r);
  }
  return rows.filter(r => !r.prUrl || ownerByUrl.get(r.prUrl) === r);
}

export function noRowOfPrMerged(): SQL {
  return sql`not exists (select 1 from "workers" "pr_row" where "pr_row"."pr_url" = ${workers.prUrl} and "pr_row"."pr_number" = ${workers.prNumber} and "pr_row"."merged_at" is not null)`;
}
