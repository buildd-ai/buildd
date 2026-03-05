import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { objectives, tasks, taskSchedules, workspaces } from '@buildd/core/db/schema';
import { eq, and } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { getUserTeamIds } from '@/lib/team-access';
import { computeNextRunAt } from '@/lib/schedule-helpers';

async function resolveTeamIds(user: any, apiAccount: any): Promise<string[]> {
  if (apiAccount) return [apiAccount.teamId];
  if (user) return getUserTeamIds(user.id);
  return [];
}

// GET /api/objectives/[id]
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const user = await getCurrentUser();
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  const apiAccount = await authenticateApiKey(apiKey);

  if (!user && !apiAccount) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (apiAccount && apiAccount.level !== 'admin') {
    return NextResponse.json({ error: 'Requires admin-level API key' }, { status: 403 });
  }

  try {
    const teamIds = await resolveTeamIds(user, apiAccount);

    const objective = await db.query.objectives.findFirst({
      where: eq(objectives.id, id),
      with: {
        workspace: { columns: { id: true, name: true } },
        tasks: {
          columns: { id: true, title: true, status: true, priority: true, createdAt: true },
          orderBy: (tasks, { desc }) => [desc(tasks.createdAt)],
        },
        subObjectives: { columns: { id: true, title: true, status: true } },
        schedule: true,
      },
    });

    if (!objective || !teamIds.includes(objective.teamId)) {
      return NextResponse.json({ error: 'Objective not found' }, { status: 404 });
    }

    const totalTasks = objective.tasks?.length || 0;
    const completedTasks = objective.tasks?.filter(t => t.status === 'completed').length || 0;
    const progress = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;

    return NextResponse.json({
      ...objective,
      totalTasks,
      completedTasks,
      progress,
    });
  } catch (error) {
    console.error('Get objective error:', error);
    return NextResponse.json({ error: 'Failed to get objective' }, { status: 500 });
  }
}

// PATCH /api/objectives/[id]
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const user = await getCurrentUser();
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  const apiAccount = await authenticateApiKey(apiKey);

  if (!user && !apiAccount) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (apiAccount && apiAccount.level !== 'admin') {
    return NextResponse.json({ error: 'Requires admin-level API key' }, { status: 403 });
  }

  try {
    const teamIds = await resolveTeamIds(user, apiAccount);

    const existing = await db.query.objectives.findFirst({
      where: eq(objectives.id, id),
    });

    if (!existing || !teamIds.includes(existing.teamId)) {
      return NextResponse.json({ error: 'Objective not found' }, { status: 404 });
    }

    const body = await req.json();
    const { title, description, status, priority, cronExpression, workspaceId } = body;

    const updateData: Partial<typeof objectives.$inferInsert> = {
      updatedAt: new Date(),
    };

    if (title !== undefined) updateData.title = title;
    if (description !== undefined) updateData.description = description;
    if (status !== undefined) {
      const validStatuses = ['active', 'paused', 'completed', 'archived'];
      if (!validStatuses.includes(status)) {
        return NextResponse.json({ error: `Invalid status. Must be one of: ${validStatuses.join(', ')}` }, { status: 400 });
      }
      updateData.status = status;
    }
    if (priority !== undefined) updateData.priority = priority;
    if (workspaceId !== undefined) updateData.workspaceId = workspaceId || null;

    // Handle cronExpression changes
    if (cronExpression !== undefined) {
      updateData.cronExpression = cronExpression || null;

      const effectiveWorkspaceId = workspaceId !== undefined ? workspaceId : existing.workspaceId;

      if (cronExpression && effectiveWorkspaceId) {
        if (existing.scheduleId) {
          // Update existing schedule
          const nextRunAt = computeNextRunAt(cronExpression, 'UTC');
          await db
            .update(taskSchedules)
            .set({
              cronExpression,
              nextRunAt,
              name: `Objective: ${title || existing.title}`,
              taskTemplate: {
                title: `Objective: ${title || existing.title}`,
                mode: 'planning' as const,
                priority: priority !== undefined ? priority : existing.priority,
              },
              updatedAt: new Date(),
            })
            .where(eq(taskSchedules.id, existing.scheduleId));
        } else {
          // Create new schedule
          const nextRunAt = computeNextRunAt(cronExpression, 'UTC');
          const [schedule] = await db
            .insert(taskSchedules)
            .values({
              workspaceId: effectiveWorkspaceId,
              name: `Objective: ${title || existing.title}`,
              cronExpression,
              timezone: 'UTC',
              taskTemplate: {
                title: `Objective: ${title || existing.title}`,
                mode: 'planning' as const,
                priority: priority !== undefined ? priority : existing.priority,
              },
              nextRunAt,
              createdByUserId: user?.id || null,
            })
            .returning();
          updateData.scheduleId = schedule.id;
        }
      } else if (!cronExpression && existing.scheduleId) {
        // Remove schedule when cron cleared
        await db.delete(taskSchedules).where(eq(taskSchedules.id, existing.scheduleId));
        updateData.scheduleId = null;
      }
    }

    const [updated] = await db
      .update(objectives)
      .set(updateData)
      .where(eq(objectives.id, id))
      .returning();

    return NextResponse.json(updated);
  } catch (error) {
    console.error('Update objective error:', error);
    return NextResponse.json({ error: 'Failed to update objective' }, { status: 500 });
  }
}

// DELETE /api/objectives/[id]
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const user = await getCurrentUser();
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  const apiAccount = await authenticateApiKey(apiKey);

  if (!user && !apiAccount) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (apiAccount && apiAccount.level !== 'admin') {
    return NextResponse.json({ error: 'Requires admin-level API key' }, { status: 403 });
  }

  try {
    const teamIds = await resolveTeamIds(user, apiAccount);

    const existing = await db.query.objectives.findFirst({
      where: eq(objectives.id, id),
    });

    if (!existing || !teamIds.includes(existing.teamId)) {
      return NextResponse.json({ error: 'Objective not found' }, { status: 404 });
    }

    // Clean up linked schedule
    if (existing.scheduleId) {
      await db.delete(taskSchedules).where(eq(taskSchedules.id, existing.scheduleId));
    }

    // Tasks keep objectiveId=null via ON DELETE SET NULL
    await db.delete(objectives).where(eq(objectives.id, id));

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Delete objective error:', error);
    return NextResponse.json({ error: 'Failed to delete objective' }, { status: 500 });
  }
}
