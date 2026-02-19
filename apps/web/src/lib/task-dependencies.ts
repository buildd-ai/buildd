import { db } from '@buildd/core/db';
import { tasks, workspaces } from '@buildd/core/db/schema';
import { eq, sql } from 'drizzle-orm';
import { triggerEvent, channels, events } from '@/lib/pusher';
import { dispatchNewTask } from '@/lib/task-dispatch';

/**
 * Resolve dependencies when a task reaches a terminal state (completed/failed).
 *
 * Finds all tasks in the same workspace that are blocked by the completed task,
 * removes it from their blockedByTaskIds array, and unblocks any that have no
 * remaining blockers.
 */
export async function resolveCompletedTask(
  completedTaskId: string,
  workspaceId: string
): Promise<void> {
  // Atomically remove completedTaskId from blockedByTaskIds and transition
  // tasks to 'pending' when their blocker list becomes empty.
  // Uses Postgres JSONB operators: @> for contains, - for removal.
  const unblockedTasks = await db.execute(sql`
    UPDATE tasks
    SET
      blocked_by_task_ids = blocked_by_task_ids - ${completedTaskId}::text,
      status = CASE
        WHEN jsonb_array_length(blocked_by_task_ids - ${completedTaskId}::text) = 0
        THEN 'pending'
        ELSE status
      END,
      updated_at = NOW()
    WHERE workspace_id = ${workspaceId}
      AND status = 'blocked'
      AND blocked_by_task_ids @> ${JSON.stringify([completedTaskId])}::jsonb
    RETURNING *
  `);

  const rows = (unblockedTasks as any).rows || unblockedTasks || [];
  const newlyPending = rows.filter((r: any) => r.status === 'pending');

  if (newlyPending.length > 0) {
    // Fetch workspace once for all dispatches (same workspace)
    const workspace = await db.query.workspaces.findFirst({
      where: eq(workspaces.id, workspaceId),
    });

    for (const row of newlyPending) {
      if (workspace) {
        await dispatchNewTask(
          {
            id: row.id,
            title: row.title,
            description: row.description,
            workspaceId: row.workspace_id,
            mode: row.mode,
            priority: row.priority,
          },
          workspace
        );
      }

      // Fire Pusher event for real-time dashboard update
      await triggerEvent(
        channels.workspace(workspaceId),
        events.TASK_UNBLOCKED,
        {
          task: {
            id: row.id,
            title: row.title,
            status: 'pending',
            workspaceId: row.workspace_id,
          },
        }
      );
    }
  }

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
