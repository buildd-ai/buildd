/**
 * A failed task whose deliverable landed anyway must not count as a mission
 * failure.
 *
 * Mission a1bd36bc counted five failed rescue tasks as "deliverable task(s)
 * failed" even though the PR they were rescuing (#2456) had already merged —
 * the rescue attempts lost the race to a sibling that succeeded, and the
 * platform read that as the mission being broken. This module answers, for a
 * batch of failed tasks, which of them are actually superseded: their target
 * PR merged, or a title-equivalent sibling task completed with a merged PR
 * after they were created.
 *
 * Read-only and best-effort: a task this cannot classify is left un-superseded
 * (reported as a real failure), never the other way around — the cost of
 * missing a supersession is a stale "failing" badge; the cost of inventing one
 * is hiding a real failure.
 */
import { db } from '@buildd/core/db';
import { tasks, workers } from '@buildd/core/db/schema';
import { and, eq, inArray, isNotNull } from 'drizzle-orm';

export interface SupersededCheckTask {
  id: string;
  title: string | null;
  subjectPrNumber: number | null;
  createdAt: Date | null;
}

export interface SupersededResult {
  taskId: string;
  /** The PR that satisfied this task's deliverable. */
  prNumber: number;
  /** The sibling task that shipped it, when supersession was found via a title-equivalent retry. */
  supersedingTaskId: string | null;
}

/**
 * Classify which of the given (already-failed) tasks are superseded.
 *
 * Two independent routes, either is sufficient:
 *  1. `subjectPrNumber` names the PR this task was working — if any worker in
 *     the mission's workspace merged that PR number, the deliverable shipped.
 *  2. No subject anchor, or it didn't match: look for a same-mission task with
 *     the identical title, `completed`, created after this one, whose latest
 *     worker's PR merged — a retry that succeeded under a different task id.
 */
export async function computeSupersededFailedTasks(
  missionId: string,
  workspaceId: string | null,
  failedTasks: SupersededCheckTask[],
): Promise<Map<string, SupersededResult>> {
  const result = new Map<string, SupersededResult>();
  if (failedTasks.length === 0) return result;

  const prNumbers = [...new Set(
    failedTasks.map(t => t.subjectPrNumber).filter((n): n is number => n != null),
  )];
  const titles = [...new Set(
    failedTasks.map(t => t.title).filter((t): t is string => !!t),
  )];

  const [mergedWorkers, titleSiblings] = await Promise.all([
    prNumbers.length > 0 && workspaceId != null
      ? db.query.workers.findMany({
          where: and(
            eq(workers.workspaceId, workspaceId),
            inArray(workers.prNumber, prNumbers),
            isNotNull(workers.mergedAt),
          ),
          columns: { prNumber: true },
        })
      : Promise.resolve([]),
    titles.length > 0
      ? db.query.tasks.findMany({
          where: and(
            eq(tasks.missionId, missionId),
            eq(tasks.status, 'completed'),
            inArray(tasks.title, titles),
          ),
          columns: { id: true, title: true, createdAt: true },
          with: {
            workers: {
              columns: { prNumber: true, mergedAt: true },
              orderBy: (w, { desc }) => [desc(w.startedAt)],
              limit: 1,
            },
          },
        })
      : Promise.resolve([]),
  ]);

  const mergedPrNumbers = new Set(
    mergedWorkers.map(w => w.prNumber).filter((n): n is number => n != null),
  );

  for (const t of failedTasks) {
    if (t.subjectPrNumber != null && mergedPrNumbers.has(t.subjectPrNumber)) {
      result.set(t.id, { taskId: t.id, prNumber: t.subjectPrNumber, supersedingTaskId: null });
      continue;
    }

    if (!t.title || !t.createdAt) continue;
    const sibling = titleSiblings.find(s => {
      if (s.id === t.id || s.title !== t.title) return false;
      if (new Date(s.createdAt).getTime() <= t.createdAt!.getTime()) return false;
      const w = (s.workers as Array<{ prNumber: number | null; mergedAt: Date | null }>)[0];
      return !!w?.mergedAt && w.prNumber != null;
    });
    if (sibling) {
      const w = (sibling.workers as Array<{ prNumber: number | null; mergedAt: Date | null }>)[0];
      result.set(t.id, { taskId: t.id, prNumber: w.prNumber!, supersedingTaskId: sibling.id });
    }
  }

  return result;
}
