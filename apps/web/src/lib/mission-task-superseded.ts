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
 * after they were created. A failed visual audit is superseded when a later
 * completed audit replaced it (the visual review model's `replacedAudits`).
 *
 * Read-only and best-effort: a task this cannot classify is left un-superseded
 * (reported as a real failure), never the other way around — the cost of
 * missing a supersession is a stale "failing" badge; the cost of inventing one
 * is hiding a real failure.
 */
import { db } from '@buildd/core/db';
import { tasks, workers } from '@buildd/core/db/schema';
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { VISUAL_AUDITOR_ROLE_SLUG } from '@buildd/shared';

export interface SupersededCheckTask {
  id: string;
  title: string | null;
  subjectPrNumber: number | null;
  createdAt: Date | null;
  /** Selects the audit route: only a `visual-auditor` row can be replaced by a later audit. */
  roleSlug?: string | null;
}

export interface SupersededResult {
  taskId: string;
  /** The PR that satisfied this task's deliverable. Null for a replaced audit, which opens none. */
  prNumber: number | null;
  /** The sibling task that shipped it (title-equivalent retry), or the audit that replaced it. */
  supersedingTaskId: string | null;
  /** A failed visual audit a later completed audit replaced. */
  replacedByAudit?: true;
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
 *  3. A failed visual audit: the visual review model records it replaced by a
 *     later completed audit with valid phone and desktop coverage and nothing
 *     unresolved. Never applied to any other task; a read error replaces nothing.
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

  const failedAudits = failedTasks.filter(t => t.roleSlug === VISUAL_AUDITOR_ROLE_SLUG);

  const [mergedWorkers, titleSiblings, replacedAudits] = await Promise.all([
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
    failedAudits.length > 0
      ? import('@/lib/visual-review-load')
          .then(({ loadVisualReview }) => loadVisualReview({ id: missionId, workspaceId }))
          .then(m => m.replacedAudits ?? [])
          .catch(() => [])
      : Promise.resolve([]),
  ]);

  const mergedPrNumbers = new Set(
    mergedWorkers.map(w => w.prNumber).filter((n): n is number => n != null),
  );

  for (const r of replacedAudits) {
    if (!failedAudits.some(t => t.id === r.auditTaskId)) continue;
    result.set(r.auditTaskId, { taskId: r.auditTaskId, prNumber: null, supersedingTaskId: r.replacedBy[0] ?? null, replacedByAudit: true });
  }

  for (const t of failedTasks) {
    if (result.has(t.id)) continue;
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
