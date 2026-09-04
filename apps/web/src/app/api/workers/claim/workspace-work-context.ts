/**
 * Workspace work-in-flight context — tells a claiming agent what its siblings
 * are already doing, so it doesn't re-discover or re-implement their work.
 *
 * Two independent signals, both scoped to the claimed task's workspace:
 *   - openPRs: branches and PRs from other live workers (agent doctrine: read
 *     the open PR before touching the same area)
 *   - siblingTaskManifests: path manifests declared by pending/active sibling
 *     tasks, so a file already owned by another task is visible up front
 */
import { db } from '@buildd/core/db';
import { tasks, workers } from '@buildd/core/db/schema';
import { and, inArray, isNotNull, isNull, not } from 'drizzle-orm';
import type { ClaimTasksResponse } from '@buildd/shared';

/** The claim-candidate rows this block looks tasks up in. */
type ClaimedTask = { id: string; workspaceId: string };

/**
 * Attach `openPRs` and `siblingTaskManifests` to each claimed worker.
 *
 * Both are capped/filtered per workspace, so a worker only ever sees context
 * from the workspace its own task belongs to.
 */
export async function attachWorkspaceWorkContext(
  claimedWorkers: ClaimTasksResponse['workers'],
  claimedTasks: readonly ClaimedTask[],
): Promise<void> {
  if (claimedWorkers.length === 0) return;

  const claimedWorkerIds = claimedWorkers.map(cw => cw.id);
  // Group claimed workers by workspace
  const workspaceIds = [...new Set(claimedWorkers.map(cw => {
    const task = claimedTasks.find(t => t.id === cw.taskId);
    return task?.workspaceId;
  }).filter(Boolean))] as string[];

  if (workspaceIds.length > 0) {
    const openPRWorkers = await db.query.workers.findMany({
      where: and(
        inArray(workers.workspaceId, workspaceIds),
        not(isNull(workers.prUrl)),
        inArray(workers.status, ['running', 'idle', 'starting', 'waiting_input', 'completed']),
        not(inArray(workers.id, claimedWorkerIds)),
      ),
      columns: { id: true, branch: true, prUrl: true, prNumber: true, taskId: true, workspaceId: true },
      orderBy: (workers, { desc }) => [desc(workers.createdAt)],
      limit: 10,
    });

    if (openPRWorkers.length > 0) {
      // Fetch task titles and manifests for PR context
      const prTaskIds = openPRWorkers.map(w => w.taskId).filter(Boolean) as string[];
      const prTasks = prTaskIds.length > 0
        ? (await db.query.tasks.findMany({
            where: inArray(tasks.id, prTaskIds),
            columns: { id: true, title: true, pathManifest: true },
          })) ?? []
        : [];
      const taskTitleMap = new Map(prTasks.map(t => [t.id, t.title]));
      const taskManifestMap = new Map(prTasks.map(t => [t.id, t.pathManifest as string[] | null]));

      const openPRs = openPRWorkers.map(w => ({
        branch: w.branch,
        prUrl: w.prUrl,
        prNumber: w.prNumber,
        taskTitle: w.taskId ? taskTitleMap.get(w.taskId) || null : null,
        pathManifest: w.taskId ? (taskManifestMap.get(w.taskId) ?? null) : null,
        workspaceId: w.workspaceId,
      }));

      for (const cw of claimedWorkers) {
        const task = claimedTasks.find(t => t.id === cw.taskId);
        const wsOpenPRs = openPRs.filter(pr => pr.workspaceId === task?.workspaceId);
        if (wsOpenPRs.length > 0) {
          (cw as any).openPRs = wsOpenPRs;
        }
      }
    }

    // Inject sibling task manifests so agents can check whether a file they're about
    // to create is already owned by a pending/active sibling task.
    // (Agent doctrine: never re-implement another task's declared deliverable.)
    const siblingManifestTasks = (await db.query.tasks.findMany({
      where: and(
        inArray(tasks.workspaceId, workspaceIds),
        inArray(tasks.status, ['pending', 'assigned', 'in_progress']),
        isNotNull(tasks.pathManifest),
        not(inArray(tasks.id, claimedWorkers.map(cw => cw.taskId))),
      ),
      columns: { id: true, title: true, pathManifest: true, workspaceId: true },
    })) ?? [];

    if (siblingManifestTasks.length > 0) {
      for (const cw of claimedWorkers) {
        const task = claimedTasks.find(t => t.id === cw.taskId);
        const siblings = siblingManifestTasks
          .filter(s => s.workspaceId === task?.workspaceId)
          .map(s => ({ id: s.id, title: s.title, pathManifest: s.pathManifest as string[] }));
        if (siblings.length > 0) {
          (cw as any).siblingTaskManifests = siblings;
        }
      }
    }
  }
}
