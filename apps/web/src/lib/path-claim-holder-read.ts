import { db } from '@buildd/core/db';
import { pathClaimWaiters } from '@buildd/core/db/schema';
import { and, eq } from 'drizzle-orm';

/**
 * True when `task` currently blocks the caller's own task on a path claim (the
 * caller is a registered waiter on it). check_path_claim names that holder by
 * id, so a task-token caller must be able to read it to coordinate a release,
 * even when the holder sits on a different mission or none.
 */
export async function taskScopeIsPathClaimHolder(
  account: { taskScope?: { taskId: string; workspaceId: string } },
  task: { id: string; workspaceId: string | null },
): Promise<boolean> {
  if (!account.taskScope) return false;
  if (task.workspaceId !== account.taskScope.workspaceId) return false;
  const row = await db.query.pathClaimWaiters.findFirst({
    where: and(
      eq(pathClaimWaiters.waitingTaskId, account.taskScope.taskId),
      eq(pathClaimWaiters.blockingTaskId, task.id),
    ),
    columns: { id: true },
  });
  return !!row;
}
