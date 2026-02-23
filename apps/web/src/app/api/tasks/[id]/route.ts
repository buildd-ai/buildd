import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { tasks, workspaces } from '@buildd/core/db/schema';
import { eq, sql, inArray } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { verifyWorkspaceAccess, verifyAccountWorkspaceAccess } from '@/lib/team-access';
import { triggerEvent, channels, events } from '@/lib/pusher';
import { dispatchNewTask } from '@/lib/task-dispatch';

// GET /api/tasks/[id] - Get a single task
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  // Dev mode returns mock task data so polling doesn't break
  if (process.env.NODE_ENV === 'development') {
    return NextResponse.json({
      id,
      title: 'Development mode task',
      description: null,
      status: 'pending',
      workspaceId: 'dev-workspace',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }

  const user = await getCurrentUser();
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  const apiAccount = await authenticateApiKey(apiKey);

  if (!user && !apiAccount) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const task = await db.query.tasks.findFirst({
      where: eq(tasks.id, id),
      with: { workspace: true },
    });

    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    // Verify access
    if (user && !apiAccount) {
      const access = await verifyWorkspaceAccess(user.id, task.workspaceId);
      if (!access) return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    } else if (apiAccount) {
      const hasAccess = await verifyAccountWorkspaceAccess(apiAccount.id, task.workspaceId);
      if (!hasAccess) return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    return NextResponse.json(task);
  } catch (error) {
    console.error('Get task error:', error);
    return NextResponse.json({ error: 'Failed to get task' }, { status: 500 });
  }
}

// PATCH /api/tasks/[id] - Update a task
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  // Dev mode returns mock
  if (process.env.NODE_ENV === 'development') {
    return NextResponse.json({ id, title: 'Updated Task' });
  }

  const user = await getCurrentUser();
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  const apiAccount = await authenticateApiKey(apiKey);

  if (!user && !apiAccount) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const task = await db.query.tasks.findFirst({
      where: eq(tasks.id, id),
      with: { workspace: true },
    });

    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    // Verify access
    if (user && !apiAccount) {
      const access = await verifyWorkspaceAccess(user.id, task.workspaceId);
      if (!access) return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    } else if (apiAccount) {
      const hasAccess = await verifyAccountWorkspaceAccess(apiAccount.id, task.workspaceId);
      if (!hasAccess) return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    const body = await req.json();
    const { title, description, priority, project, addBlockedByTaskIds, removeBlockedByTaskIds } = body;

    const updateData: Partial<typeof tasks.$inferInsert> = {
      updatedAt: new Date(),
    };

    if (title !== undefined) updateData.title = title;
    if (description !== undefined) updateData.description = description;
    if (priority !== undefined) updateData.priority = priority;
    if (project !== undefined) updateData.project = project;

    const [updated] = await db
      .update(tasks)
      .set(updateData)
      .where(eq(tasks.id, id))
      .returning();

    // Handle addBlockedByTaskIds
    if (Array.isArray(addBlockedByTaskIds) && addBlockedByTaskIds.length > 0) {
      // Validate all IDs are strings
      const validIds = addBlockedByTaskIds.every((id: unknown) => typeof id === 'string');
      if (!validIds) {
        return NextResponse.json({ error: 'addBlockedByTaskIds must be an array of strings' }, { status: 400 });
      }

      // Verify all referenced tasks exist in the same workspace
      const blockerTasks = await db.query.tasks.findMany({
        where: inArray(tasks.id, addBlockedByTaskIds),
        columns: { id: true, workspaceId: true },
      });

      const validBlockerIds = blockerTasks
        .filter((t) => t.workspaceId === task.workspaceId)
        .map((t) => t.id);

      if (validBlockerIds.length !== addBlockedByTaskIds.length) {
        return NextResponse.json(
          { error: 'Some blockedByTaskIds do not exist in the same workspace' },
          { status: 400 }
        );
      }

      // Atomically append new IDs to the JSONB array and set status to 'blocked'
      await db.execute(sql`
        UPDATE tasks
        SET
          blocked_by_task_ids = (
            SELECT jsonb_agg(DISTINCT elem)
            FROM jsonb_array_elements(
              COALESCE(blocked_by_task_ids, '[]'::jsonb) || ${JSON.stringify(validBlockerIds)}::jsonb
            ) AS elem
          ),
          status = CASE
            WHEN status = 'pending' THEN 'blocked'
            ELSE status
          END,
          updated_at = NOW()
        WHERE id = ${id}
      `);
    }

    // Handle removeBlockedByTaskIds
    if (Array.isArray(removeBlockedByTaskIds) && removeBlockedByTaskIds.length > 0) {
      // Validate all IDs are strings
      const validIds = removeBlockedByTaskIds.every((rid: unknown) => typeof rid === 'string');
      if (!validIds) {
        return NextResponse.json({ error: 'removeBlockedByTaskIds must be an array of strings' }, { status: 400 });
      }

      // Remove each ID from the JSONB array
      for (const removeId of removeBlockedByTaskIds) {
        await db.execute(sql`
          UPDATE tasks
          SET
            blocked_by_task_ids = blocked_by_task_ids - ${removeId}::text,
            updated_at = NOW()
          WHERE id = ${id}
        `);
      }

      // Check if blockedByTaskIds is now empty and status is 'blocked' — transition to 'pending'
      const afterRemoval = await db.execute(sql`
        UPDATE tasks
        SET
          status = 'pending',
          updated_at = NOW()
        WHERE id = ${id}
          AND status = 'blocked'
          AND (blocked_by_task_ids IS NULL OR jsonb_array_length(blocked_by_task_ids) = 0)
        RETURNING *
      `);

      const rows = (afterRemoval as any).rows || afterRemoval || [];
      if (rows.length > 0) {
        const unblockedTask = rows[0];

        // Fetch workspace for dispatch
        const workspace = await db.query.workspaces.findFirst({
          where: eq(workspaces.id, task.workspaceId),
        });

        if (workspace) {
          await dispatchNewTask(
            {
              id: unblockedTask.id,
              title: unblockedTask.title,
              description: unblockedTask.description,
              workspaceId: unblockedTask.workspace_id,
              mode: unblockedTask.mode,
              priority: unblockedTask.priority,
            },
            workspace
          );
        }

        // Fire Pusher event for real-time dashboard update
        await triggerEvent(
          channels.workspace(task.workspaceId),
          events.TASK_UNBLOCKED,
          {
            task: {
              id: unblockedTask.id,
              title: unblockedTask.title,
              status: 'pending',
              workspaceId: unblockedTask.workspace_id,
            },
          }
        );
      }
    }

    // Re-fetch the task to return the latest state after dependency changes
    if (
      (Array.isArray(addBlockedByTaskIds) && addBlockedByTaskIds.length > 0) ||
      (Array.isArray(removeBlockedByTaskIds) && removeBlockedByTaskIds.length > 0)
    ) {
      const refreshed = await db.query.tasks.findFirst({
        where: eq(tasks.id, id),
      });
      return NextResponse.json(refreshed);
    }

    return NextResponse.json(updated);
  } catch (error) {
    console.error('Update task error:', error);
    return NextResponse.json({ error: 'Failed to update task' }, { status: 500 });
  }
}

// DELETE /api/tasks/[id] - Delete a task (only pending tasks)
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  // Dev mode returns success
  if (process.env.NODE_ENV === 'development') {
    return NextResponse.json({ success: true });
  }

  const user = await getCurrentUser();
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  const apiAccount = await authenticateApiKey(apiKey);

  if (!user && !apiAccount) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const task = await db.query.tasks.findFirst({
      where: eq(tasks.id, id),
      with: { workspace: true },
    });

    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    // Verify access
    if (user && !apiAccount) {
      const access = await verifyWorkspaceAccess(user.id, task.workspaceId);
      if (!access) return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    } else if (apiAccount) {
      const hasAccess = await verifyAccountWorkspaceAccess(apiAccount.id, task.workspaceId);
      if (!hasAccess) return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    // ?force=true skips status check (for test cleanup scripts)
    const force = req.nextUrl.searchParams.get('force') === 'true';

    if (!force) {
      // Only allow deleting pending, assigned, failed, or completed tasks (not actively running)
      if (!['pending', 'assigned', 'failed', 'completed', 'blocked'].includes(task.status)) {
        return NextResponse.json(
          { error: `Cannot delete ${task.status} tasks. Wait for completion or use reassign.` },
          { status: 400 }
        );
      }
    }

    await db.delete(tasks).where(eq(tasks.id, id));

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Delete task error:', error);
    return NextResponse.json({ error: 'Failed to delete task' }, { status: 500 });
  }
}
