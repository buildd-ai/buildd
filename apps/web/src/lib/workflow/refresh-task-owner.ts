/**
 * One writer per mission integration branch while a refresh is under repair.
 *
 * While `missions.branchRefreshConflictTaskId` names a live task, that task is
 * the only writer that merges trunk into the branch. The kernel's plain
 * update-branch, a bound refresh and the prompts of CI-fix / conflict-fix
 * attempts on the mission PR all consult this: two writers merging the same
 * trunk into one branch leave the conflict task's PR with an empty diff.
 */
import { and, eq, notInArray } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { missions, tasks } from '@buildd/core/db/schema';
import { sqlWhere } from '@buildd/core/db/relational-sql';
import { TERMINAL_TASK_STATUSES } from '@buildd/shared';

/**
 * The live refresh conflict task of the mission whose integration branch is `headRef`, or null.
 * A pointer at a row not written yet is a reservation: live. A terminal task with a running
 * retry is still the repair, so live too.
 */
export async function liveRefreshConflictTaskFor(workspaceId: string, headRef: string | null | undefined): Promise<string | null> {
  if (!headRef) return null;
  const mission = await db.query.missions.findFirst({
    where: sqlWhere(and(eq(missions.workspaceId, workspaceId), eq(missions.integrationBranchEnabled, true), eq(missions.workingBranch, headRef))),
    columns: { branchRefreshConflictTaskId: true },
  });
  const taskId = mission?.branchRefreshConflictTaskId;
  if (!taskId) return null;
  const task = await db.query.tasks.findFirst({ where: sqlWhere(eq(tasks.id, taskId)), columns: { status: true } });
  if (!task) return taskId;
  if (!(TERMINAL_TASK_STATUSES as readonly string[]).includes(task.status)) return taskId;
  const retry = await db.query.tasks.findFirst({
    where: sqlWhere(and(eq(tasks.parentTaskId, taskId), notInArray(tasks.status, [...TERMINAL_TASK_STATUSES]))),
    columns: { id: true },
  });
  return retry ? taskId : null;
}

/** The paragraph appended to a repair prompt for a PR whose head is a mission branch under refresh repair. */
export const refreshOwnerNote = (taskId: string): string =>
  `\n\n## Do not merge trunk into this branch\n\nA refresh conflict task (\`${taskId.slice(0, 8)}\`) owns merging trunk into this mission branch right now. Do not merge or rebase trunk (dev/main) into it, and do not use "Update branch". Fix only what this task names; if it needs trunk's changes, say so and stop.`;
