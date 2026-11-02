/**
 * Writes for named replacements (see `./pr-named-replacement` for what one is).
 *
 * Display only: these columns are never read by a completion or merge gate, so
 * a wrong or stale name costs a link on the mission page, nothing more. Every
 * write is one guarded UPDATE (no transaction), and only on a worker whose PR
 * has not merged: a merged PR has no replacement.
 */

import { db } from '@buildd/core/db';
import { workers } from '@buildd/core/db/schema';
import { and, eq, isNull, ne, or } from 'drizzle-orm';
import { prUrlFor, workerOwnsPr } from '@/lib/repo-scope';
import { triggerEvent, channels, events } from '@/lib/pusher';

const isPrNumber = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) > 0;

type Row = { id: string; workspaceId: string; taskId: string | null };

/** The same nudge the webhook sends after a PR fact, so an open mission page refreshes. */
async function nudge(rows: Row[]): Promise<void> {
  for (const row of rows) {
    await triggerEvent(channels.workspaceActivity(row.workspaceId), events.WORKER_PROGRESS, { taskId: row.taskId })
      .catch((err) => console.warn(`[named-replacement] nudge for worker ${row.id} failed:`, err));
  }
}

/**
 * Record that `replacementPrNumber` was named as the replacement of
 * `closedPrNumber` in `repoFullName`, on every unmerged worker owning the
 * closed PR. Returns the rows updated. Never throws: the callers are a webhook
 * and a close that already happened, neither of which should fail over this.
 */
export async function recordNamedReplacement(p: {
  repoFullName: string;
  closedPrNumber: number;
  replacementPrNumber: number;
}): Promise<number> {
  const { repoFullName, closedPrNumber, replacementPrNumber } = p;
  if (!isPrNumber(closedPrNumber) || !isPrNumber(replacementPrNumber) || closedPrNumber === replacementPrNumber) return 0;
  try {
    const rows: Row[] = await db
      .update(workers)
      .set({
        namedReplacementPrNumber: replacementPrNumber,
        namedReplacementPrUrl: prUrlFor(repoFullName, replacementPrNumber),
        updatedAt: new Date(),
      })
      .where(and(
        workerOwnsPr(repoFullName, closedPrNumber),
        isNull(workers.mergedAt),
        // The same name again (every `edited` delivery repeats it) is no write.
        or(isNull(workers.namedReplacementPrNumber), ne(workers.namedReplacementPrNumber, replacementPrNumber)),
      ))
      .returning({ id: workers.id, workspaceId: workers.workspaceId, taskId: workers.taskId });
    await nudge(rows);
    return rows.length;
  } catch (err) {
    console.error(`[named-replacement] ${repoFullName}#${closedPrNumber} -> #${replacementPrNumber} failed:`, err);
    return 0;
  }
}

/**
 * A person's "Link replacement" on one worker. `updated: false` means the row
 * did not match: it is gone, or its PR merged since the caller read it.
 */
export async function linkNamedReplacement(p: {
  workerId: string;
  repoFullName: string;
  prNumber: number;
}): Promise<{ updated: boolean; url: string }> {
  // The replacement's number, never this worker's own PR: the write-site pin (pr-write-sites.test.ts) reads `prNumber:` as one.
  const replacement = p.prNumber;
  const url = prUrlFor(p.repoFullName, replacement);
  const rows: Row[] = await db
    .update(workers)
    .set({ namedReplacementPrNumber: replacement, namedReplacementPrUrl: url, updatedAt: new Date() })
    .where(and(eq(workers.id, p.workerId), isNull(workers.mergedAt)))
    .returning({ id: workers.id, workspaceId: workers.workspaceId, taskId: workers.taskId });
  await nudge(rows);
  return { updated: rows.length > 0, url };
}
