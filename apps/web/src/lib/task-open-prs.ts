/**
 * A task can ship as several PRs (a stacked series). Merging one of them is not
 * the task finishing: completing it on the first merge ends the worker that
 * still owns the rest and releases dependents onto a half-landed task.
 *
 * "Open" here is any worker row of the task that carries a PR other than the
 * one that just merged, which no row has recorded as merged, and whose
 * lifecycle is not terminal (merged / closed / unresolvable — closing a PR
 * unmerged is how one is explicitly superseded or abandoned).
 *
 * Read-only over `workers`, the same fact cache the merge stamp writes
 * (recordPrFact). A worker row holds one PR, so a PR its row has since been
 * re-pointed away from is invisible here; that only makes the check more
 * permissive (the pre-existing behaviour), never stricter.
 */
import { eq } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { workers } from '@buildd/core/db/schema';
import { isTerminalPrLifecycle } from '@/lib/dep-gate-contract';

interface PrRow {
  prUrl: string | null;
  prNumber: number | null;
  mergedAt: Date | string | null;
  prLifecycleStatus: string | null;
}

export function pickOtherOpenPrs(rows: readonly PrRow[], justMerged: { prUrl: string | null }): string[] {
  const mergedUrls = new Set(rows.filter(r => r.prUrl && r.mergedAt).map(r => r.prUrl!));
  if (justMerged.prUrl) mergedUrls.add(justMerged.prUrl);
  const open = new Set<string>();
  for (const r of rows) {
    if (!r.prUrl || r.prNumber == null) continue;
    if (mergedUrls.has(r.prUrl)) continue;
    if (isTerminalPrLifecycle(r.prLifecycleStatus)) continue;
    open.add(r.prUrl);
  }
  return [...open];
}

export async function otherOpenPrsOfTask(taskId: string, justMerged: { prUrl: string | null }): Promise<string[]> {
  const rows = await db
    .select({
      prUrl: workers.prUrl,
      prNumber: workers.prNumber,
      mergedAt: workers.mergedAt,
      prLifecycleStatus: workers.prLifecycleStatus,
    })
    .from(workers)
    .where(eq(workers.taskId, taskId));
  return pickOtherOpenPrs(rows, justMerged);
}
