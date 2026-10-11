/**
 * The open PRs a PR replaces: never a reason to renumber its migration.
 *
 * A successor PR (a retry that could not reuse its branch, or a rebuilt PR
 * that records what it supersedes) carries the same migration intent as its
 * predecessor. While the predecessor stays open, the open-PR collision scan
 * (`migration-inspector.ts`) treats its slot as taken. It then tells the
 * successor to renumber around the very PR it replaces, and the lower PR
 * number "owns" the slot. docs/specs/workflow-state-kernel.md §13.11 rule 5.
 *
 * Two recorded sources, never prose:
 *  - the chain the PR's own task belongs to (`context.lineagePrNumbers`,
 *    stamped by `lineageStamp` on every fix attempt);
 *  - workers whose PR is recorded as superseded by this one
 *    (`workers.supersededByPrNumber`).
 * Best-effort: a failed read returns [] (excludes nothing, the old behaviour).
 */
import { db } from '@buildd/core/db';
import { tasks, workers } from '@buildd/core/db/schema';
import { and, eq, inArray } from 'drizzle-orm';

/** Pure half: the predecessor PR numbers from loaded rows, without `prNumber` itself. */
export function predecessorsFrom(
  prNumber: number,
  ownerContexts: ReadonlyArray<unknown>,
  supersededPrNumbers: ReadonlyArray<number | null>,
): number[] {
  const out = new Set<number>();
  for (const ctx of ownerContexts) {
    const list = (ctx as { lineagePrNumbers?: unknown } | null)?.lineagePrNumbers;
    if (Array.isArray(list)) for (const n of list) if (typeof n === 'number') out.add(n);
  }
  for (const n of supersededPrNumbers) if (typeof n === 'number') out.add(n);
  out.delete(prNumber);
  return [...out].sort((a, b) => a - b);
}

export async function predecessorPrNumbers(workspaceId: string | null | undefined, prNumber: number): Promise<number[]> {
  if (!workspaceId) return [];
  try {
    const [owners, superseded] = await Promise.all([
      db.query.workers.findMany({
        where: and(eq(workers.workspaceId, workspaceId), eq(workers.prNumber, prNumber)),
        columns: { taskId: true },
      }),
      db.query.workers.findMany({
        where: and(eq(workers.workspaceId, workspaceId), eq(workers.supersededByPrNumber, prNumber)),
        columns: { prNumber: true },
      }),
    ]);
    const taskIds = [...new Set(owners.map(w => w.taskId).filter((id): id is string => !!id))];
    const contexts = taskIds.length > 0
      ? (await db.query.tasks.findMany({ where: inArray(tasks.id, taskIds), columns: { context: true } })).map(t => t.context)
      : [];
    return predecessorsFrom(prNumber, contexts, superseded.map(w => w.prNumber));
  } catch (err) {
    console.warn(`[pr-predecessors] could not read predecessors of PR #${prNumber}; excluding none:`, err);
    return [];
  }
}
