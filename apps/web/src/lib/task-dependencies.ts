import { db } from '@buildd/core/db';
import { tasks } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { triggerEvent, channels, events } from '@/lib/pusher';

/**
 * Handle post-completion logic when a task reaches a terminal state (completed/failed).
 *
 * Checks if the completed task's parent has all children done and fires
 * a CHILDREN_COMPLETED Pusher event for dashboard visibility.
 */
export async function resolveCompletedTask(
  completedTaskId: string,
  _workspaceId: string
): Promise<void> {
  // Check if the completed task's parent has all children done
  const completedTask = await db.query.tasks.findFirst({
    where: eq(tasks.id, completedTaskId),
    columns: { parentTaskId: true },
  });

  if (completedTask?.parentTaskId) {
    await checkChildrenCompleted(completedTask.parentTaskId);
  }
}

/**
 * Check if all children of a parent task have reached terminal state.
 * Fires a CHILDREN_COMPLETED Pusher event for dashboard visibility.
 */
async function checkChildrenCompleted(
  parentTaskId: string
): Promise<void> {
  const children = await db.query.tasks.findMany({
    where: eq(tasks.parentTaskId, parentTaskId),
    columns: { id: true, status: true, workspaceId: true },
  });

  if (children.length === 0) return;

  const allDone = children.every(
    (c) => c.status === 'completed' || c.status === 'failed'
  );

  if (allDone) {
    const workspaceId = children[0].workspaceId;
    await triggerEvent(
      channels.workspace(workspaceId),
      events.CHILDREN_COMPLETED,
      {
        parentTaskId,
        childCount: children.length,
        completed: children.filter((c) => c.status === 'completed').length,
        failed: children.filter((c) => c.status === 'failed').length,
      }
    );
  }
}
