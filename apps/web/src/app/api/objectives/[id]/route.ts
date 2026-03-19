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
          columns: { id: true, title: true, status: true, priority: true, createdAt: true, result: true, updatedAt: true },
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

    // Extract skill/recipe config from schedule template
    const templateContext = (objective.schedule as any)?.taskTemplate?.context as Record<string, unknown> | undefined;
    const isHeartbeat = templateContext?.heartbeat === true;

    // Compute heartbeat status from most recent completed task with structuredOutput
    let lastHeartbeatStatus: string | null = null;
    let lastHeartbeatAt: string | null = null;
    if (isHeartbeat) {
      const lastCompletedTask = objective.tasks?.find(
        (t: any) => t.status === 'completed' && t.result?.structuredOutput?.status
      );
      if (lastCompletedTask) {
        lastHeartbeatStatus = (lastCompletedTask as any).result?.structuredOutput?.status || null;
        lastHeartbeatAt = lastCompletedTask.updatedAt?.toISOString?.() || (lastCompletedTask.updatedAt as any) || null;
      }
    }

    return NextResponse.json({
      ...objective,
      totalTasks,
      completedTasks,
      progress,
      skillSlugs: templateContext?.skillSlugs || [],
      recipeId: templateContext?.recipeId || null,
      outputSchema: templateContext?.outputSchema || null,
      model: templateContext?.model || null,
      // Derived from schedule's taskTemplate.context for backward compatibility
      isHeartbeat,
      heartbeatChecklist: templateContext?.heartbeatChecklist || null,
      activeHoursStart: templateContext?.activeHoursStart ?? null,
      activeHoursEnd: templateContext?.activeHoursEnd ?? null,
      activeHoursTimezone: templateContext?.activeHoursTimezone || null,
      lastHeartbeatStatus,
      lastHeartbeatAt,
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
    const { title, description, status, priority, cronExpression, workspaceId, skillSlugs, recipeId, outputSchema, model,
      isHeartbeat, heartbeatChecklist, activeHoursStart, activeHoursEnd, activeHoursTimezone } = body;

    // Validate active hours range
    if (activeHoursStart !== undefined && activeHoursStart !== null && (activeHoursStart < 0 || activeHoursStart > 23)) {
      return NextResponse.json({ error: 'activeHoursStart must be between 0 and 23' }, { status: 400 });
    }
    if (activeHoursEnd !== undefined && activeHoursEnd !== null && (activeHoursEnd < 0 || activeHoursEnd > 23)) {
      return NextResponse.json({ error: 'activeHoursEnd must be between 0 and 23' }, { status: 400 });
    }

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

    // Handle cronExpression changes or skill/recipe updates on existing schedule
    const scheduleNeedsUpdate = cronExpression !== undefined || skillSlugs !== undefined || recipeId !== undefined || outputSchema !== undefined || isHeartbeat !== undefined
      || heartbeatChecklist !== undefined || activeHoursStart !== undefined || activeHoursEnd !== undefined || activeHoursTimezone !== undefined;
    if (scheduleNeedsUpdate) {
      const effectiveWorkspaceId = workspaceId !== undefined ? workspaceId : existing.workspaceId;

      // Resolve existing cron from schedule if not provided
      let existingCron: string | null = null;
      const templateContext: Record<string, unknown> = {};
      // Preserve existing context from schedule if updating
      if (existing.scheduleId) {
        const existingSchedule = await db.query.taskSchedules.findFirst({
          where: eq(taskSchedules.id, existing.scheduleId),
          columns: { taskTemplate: true, cronExpression: true },
        });
        if (existingSchedule) {
          existingCron = existingSchedule.cronExpression;
          if (existingSchedule.taskTemplate?.context) {
            Object.assign(templateContext, existingSchedule.taskTemplate.context);
          }
        }
      }
      const effectiveCron = cronExpression !== undefined ? cronExpression : existingCron;
      if (skillSlugs !== undefined) {
        if (skillSlugs?.length) templateContext.skillSlugs = skillSlugs;
        else delete templateContext.skillSlugs;
      }
      if (recipeId !== undefined) {
        if (recipeId) templateContext.recipeId = recipeId;
        else delete templateContext.recipeId;
      }
      if (outputSchema !== undefined) {
        if (outputSchema) templateContext.outputSchema = outputSchema;
        else delete templateContext.outputSchema;
      }
      if (model !== undefined) {
        if (model) templateContext.model = model;
        else delete templateContext.model;
      }
      if (isHeartbeat !== undefined) {
        if (isHeartbeat) templateContext.heartbeat = true;
        else delete templateContext.heartbeat;
      }
      if (heartbeatChecklist !== undefined) {
        if (heartbeatChecklist) templateContext.heartbeatChecklist = heartbeatChecklist;
        else delete templateContext.heartbeatChecklist;
      }
      if (activeHoursStart !== undefined) {
        if (activeHoursStart != null) templateContext.activeHoursStart = activeHoursStart;
        else delete templateContext.activeHoursStart;
      }
      if (activeHoursEnd !== undefined) {
        if (activeHoursEnd != null) templateContext.activeHoursEnd = activeHoursEnd;
        else delete templateContext.activeHoursEnd;
      }
      if (activeHoursTimezone !== undefined) {
        if (activeHoursTimezone) templateContext.activeHoursTimezone = activeHoursTimezone;
        else delete templateContext.activeHoursTimezone;
      }

      if (effectiveCron && effectiveWorkspaceId) {
        const taskTemplate = {
          title: `Objective: ${title || existing.title}`,
          mode: 'planning' as const,
          priority: priority !== undefined ? priority : existing.priority,
          ...(Object.keys(templateContext).length > 0 ? { context: templateContext } : {}),
        };

        if (existing.scheduleId) {
          // Update existing schedule
          const nextRunAt = cronExpression !== undefined
            ? computeNextRunAt(cronExpression, 'UTC')
            : undefined;
          await db
            .update(taskSchedules)
            .set({
              ...(cronExpression !== undefined ? { cronExpression, nextRunAt } : {}),
              name: `Objective: ${title || existing.title}`,
              taskTemplate,
              updatedAt: new Date(),
            })
            .where(eq(taskSchedules.id, existing.scheduleId));
        } else {
          // Create new schedule
          const nextRunAt = computeNextRunAt(effectiveCron, 'UTC');
          const [schedule] = await db
            .insert(taskSchedules)
            .values({
              workspaceId: effectiveWorkspaceId,
              name: `Objective: ${title || existing.title}`,
              cronExpression: effectiveCron,
              timezone: 'UTC',
              taskTemplate,
              nextRunAt,
              createdByUserId: user?.id || null,
            })
            .returning();
          updateData.scheduleId = schedule.id;
        }
      } else if (!effectiveCron && existing.scheduleId) {
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
