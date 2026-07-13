import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { missions, tasks, taskSchedules, workspaces, missionNotes } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { resolveAccountTeamIds } from '@/lib/team-access';
import { computeNextRunAt } from '@/lib/schedule-helpers';
import { isDeliverableTask } from '@buildd/core/mission-helpers';
import { isMissionBlocked, wouldCreateCycle } from '@/lib/mission-dependency';

const resolveTeamIds = resolveAccountTeamIds;

/** Check if a mission is accessible: team match OR open-access workspace */
async function hasMissionAccess(mission: { teamId: string; workspaceId: string | null }, teamIds: string[]): Promise<boolean> {
  if (teamIds.includes(mission.teamId)) return true;
  if (mission.workspaceId) {
    const ws = await db.query.workspaces.findFirst({
      where: eq(workspaces.id, mission.workspaceId),
      columns: { accessMode: true },
    });
    if (ws?.accessMode === 'open') return true;
  }
  return false;
}

// GET /api/missions/[id]
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

    const mission = await db.query.missions.findFirst({
      where: eq(missions.id, id),
      with: {
        workspace: { columns: { id: true, name: true } },
        tasks: {
          columns: { id: true, title: true, status: true, priority: true, roleSlug: true, createdAt: true, result: true, updatedAt: true, kind: true, creationSource: true },
          orderBy: (tasks, { desc }) => [desc(tasks.createdAt)],
        },
        subMissions: { columns: { id: true, title: true, status: true } },
        schedule: true,
      },
    });

    if (!mission || !(await hasMissionAccess(mission, teamIds))) {
      return NextResponse.json({ error: 'Mission not found' }, { status: 404 });
    }

    const deliverableTasks = mission.tasks?.filter(isDeliverableTask) || [];
    // Cancelled tasks are excluded from progress: they don't count as work to do
    // or work done, so they don't inflate the denominator when duplicates are killed.
    const countableTasks = deliverableTasks.filter(t => t.status !== 'cancelled');
    const totalTasks = countableTasks.length;
    const completedTasks = countableTasks.filter(t => t.status === 'completed').length;
    const progress = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;

    // Extract config from schedule template
    const templateContext = (mission.schedule as any)?.taskTemplate?.context as Record<string, unknown> | undefined;
    const isHeartbeat = templateContext?.heartbeat === true;

    // Compute heartbeat status from most recent completed task
    let lastHeartbeatStatus: string | null = null;
    let lastHeartbeatAt: string | null = null;
    if (isHeartbeat) {
      const lastCompletedTask = mission.tasks?.find(
        (t: any) => t.status === 'completed' && t.result?.structuredOutput?.status
      );
      if (lastCompletedTask) {
        lastHeartbeatStatus = (lastCompletedTask as any).result?.structuredOutput?.status || null;
        lastHeartbeatAt = lastCompletedTask.updatedAt?.toISOString?.() || (lastCompletedTask.updatedAt as any) || null;
      }
    }

    // Compute evaluation status from lastEvaluationTaskId
    let evaluationStatus: string | null = null;
    let lastEvaluationAt: string | null = null;
    let evaluationRationale: string | null = null;
    if (mission.lastEvaluationTaskId) {
      const evalTask = mission.tasks?.find((t: any) => t.id === mission.lastEvaluationTaskId);
      if (evalTask) {
        if (['pending', 'assigned', 'in_progress'].includes(evalTask.status)) {
          evaluationStatus = 'pending';
        } else if (evalTask.status === 'completed') {
          const evalResult = (evalTask as any).result?.structuredOutput;
          evaluationStatus = evalResult?.verdict || 'unknown';
          evaluationRationale = evalResult?.rationale || null;
          lastEvaluationAt = evalTask.updatedAt?.toISOString?.() || (evalTask.updatedAt as any) || null;
        }
      }
    }

    const blockStatus = await isMissionBlocked({
      id: mission.id,
      dependsOnMissionId: mission.dependsOnMissionId ?? null,
      gateCondition: mission.gateCondition,
      dependencyMetAt: mission.dependencyMetAt ?? null,
    });

    return NextResponse.json({
      ...mission,
      totalTasks,
      completedTasks,
      progress,
      skillSlugs: templateContext?.skillSlugs || [],
      outputSchema: templateContext?.outputSchema || null,
      model: templateContext?.model || null,
      lastHeartbeatStatus,
      lastHeartbeatAt,
      evaluationStatus,
      lastEvaluationAt,
      evaluationRationale,
      blocked: blockStatus.blocked,
      blockedReason: blockStatus.reason ?? null,
      blockedByMissionId: blockStatus.dependsOnMissionId ?? null,
      blockedByMissionTitle: blockStatus.dependsOnTitle ?? null,
    });
  } catch (error) {
    console.error('Get mission error:', error);
    return NextResponse.json({ error: 'Failed to get mission' }, { status: 500 });
  }
}

// PATCH /api/missions/[id]
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

    const existing = await db.query.missions.findFirst({
      where: eq(missions.id, id),
    });

    if (!existing || !(await hasMissionAccess(existing, teamIds))) {
      return NextResponse.json({ error: 'Mission not found' }, { status: 404 });
    }

    const body = await req.json();
    const { title, description, status, priority, cronExpression, workspaceId, skillSlugs, outputSchema, model,
      isHeartbeat, heartbeatChecklist, activeHoursStart, activeHoursEnd, activeHoursTimezone, maxConcurrentTasks, backend,
      dependsOnMission, gateCondition, orchestrationMode } = body;

    if (maxConcurrentTasks !== undefined && maxConcurrentTasks !== null && (!Number.isInteger(maxConcurrentTasks) || maxConcurrentTasks < 1)) {
      return NextResponse.json({ error: 'maxConcurrentTasks must be an integer >= 1' }, { status: 400 });
    }

    if (gateCondition !== undefined && gateCondition !== 'merged' && gateCondition !== 'completed') {
      return NextResponse.json({ error: 'gateCondition must be "merged" or "completed"' }, { status: 400 });
    }

    if (orchestrationMode !== undefined && orchestrationMode !== 'auto' && orchestrationMode !== 'manual') {
      return NextResponse.json({ error: 'orchestrationMode must be "auto" or "manual"' }, { status: 400 });
    }

    if (dependsOnMission !== undefined) {
      if (dependsOnMission !== null) {
        if (dependsOnMission === id) {
          return NextResponse.json({ error: 'A mission cannot depend on itself' }, { status: 400 });
        }
        if (await wouldCreateCycle(id, dependsOnMission)) {
          return NextResponse.json({ error: 'Setting this dependency would create a cycle' }, { status: 400 });
        }
      }
    }

    if (activeHoursStart !== undefined && activeHoursStart !== null && (activeHoursStart < 0 || activeHoursStart > 23)) {
      return NextResponse.json({ error: 'activeHoursStart must be between 0 and 23' }, { status: 400 });
    }
    if (activeHoursEnd !== undefined && activeHoursEnd !== null && (activeHoursEnd < 0 || activeHoursEnd > 23)) {
      return NextResponse.json({ error: 'activeHoursEnd must be between 0 and 23' }, { status: 400 });
    }

    const updateData: Partial<typeof missions.$inferInsert> = {
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

      if ((status === 'completed' || status === 'archived') && existing.scheduleId) {
        // Heartbeat schedules are owned by their mission — delete when mission is done
        await db.delete(taskSchedules).where(eq(taskSchedules.id, existing.scheduleId));
        updateData.scheduleId = null;
      } else if (status === 'paused' && existing.scheduleId) {
        await db.update(taskSchedules)
          .set({ enabled: false, updatedAt: new Date() })
          .where(eq(taskSchedules.id, existing.scheduleId));
      } else if (status === 'active' && existing.scheduleId) {
        await db.update(taskSchedules)
          .set({ enabled: true, updatedAt: new Date() })
          .where(eq(taskSchedules.id, existing.scheduleId));
      }
    }
    if (priority !== undefined) updateData.priority = priority;
    if (maxConcurrentTasks !== undefined) updateData.maxConcurrentTasks = maxConcurrentTasks;
    if (workspaceId !== undefined) updateData.workspaceId = workspaceId || null;
    if (backend !== undefined) {
      updateData.defaultBackend = backend === 'claude' || backend === 'codex' ? backend : null;
    }
    if (dependsOnMission !== undefined) {
      updateData.dependsOnMissionId = dependsOnMission || null;
      // When removing or changing the dependency, clear dependencyMetAt so the new dep re-evaluates
      if (dependsOnMission !== existing.dependsOnMissionId) {
        updateData.dependencyMetAt = null;
      }
    }
    if (gateCondition !== undefined) {
      updateData.gateCondition = gateCondition;
    }
    if (orchestrationMode !== undefined) {
      updateData.orchestrationMode = orchestrationMode;
    }

    // Handle schedule updates
    const scheduleNeedsUpdate = cronExpression !== undefined || skillSlugs !== undefined || outputSchema !== undefined || isHeartbeat !== undefined
      || heartbeatChecklist !== undefined || activeHoursStart !== undefined || activeHoursEnd !== undefined || activeHoursTimezone !== undefined;
    if (scheduleNeedsUpdate) {
      const effectiveWorkspaceId = workspaceId !== undefined ? workspaceId : existing.workspaceId;

      let existingCron: string | null = null;
      const templateContext: Record<string, unknown> = {};
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

      if (existing.scheduleId || (effectiveCron && effectiveWorkspaceId)) {
        const taskTemplate = {
          title: `Mission: ${title || existing.title}`,
          mode: 'planning' as const,
          priority: priority !== undefined ? priority : existing.priority,
          ...(Object.keys(templateContext).length > 0 ? { context: templateContext } : {}),
        };

        if (existing.scheduleId) {
          const nextRunAt = cronExpression !== undefined
            ? computeNextRunAt(cronExpression, 'UTC')
            : undefined;
          await db
            .update(taskSchedules)
            .set({
              ...(cronExpression !== undefined ? { cronExpression, nextRunAt } : {}),
              ...(workspaceId !== undefined ? { workspaceId: effectiveWorkspaceId } : {}),
              name: `Mission: ${title || existing.title}`,
              taskTemplate,
              updatedAt: new Date(),
            })
            .where(eq(taskSchedules.id, existing.scheduleId));
        } else {
          const nextRunAt = computeNextRunAt(effectiveCron, 'UTC');
          const [schedule] = await db
            .insert(taskSchedules)
            .values({
              workspaceId: effectiveWorkspaceId,
              name: `Mission: ${title || existing.title}`,
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
        await db.delete(taskSchedules).where(eq(taskSchedules.id, existing.scheduleId));
        updateData.scheduleId = null;
      }
    }

    // Sync schedule workspace when only workspaceId changed (no schedule fields updated)
    if (workspaceId !== undefined && !scheduleNeedsUpdate && existing.scheduleId) {
      await db.update(taskSchedules)
        .set({ workspaceId: workspaceId || null, updatedAt: new Date() })
        .where(eq(taskSchedules.id, existing.scheduleId));
    }

    const [updated] = await db
      .update(missions)
      .set(updateData)
      .where(eq(missions.id, id))
      .returning();

    // Emit audit note when orchestrationMode changes
    if (orchestrationMode !== undefined && orchestrationMode !== existing.orchestrationMode) {
      const actor = user?.id ? `user ${user.id}` : 'API caller';
      const modeLabel = orchestrationMode === 'manual' ? 'manual' : 'auto';
      const modeDesc = orchestrationMode === 'manual'
        ? 'Orchestrator is now idle — no heartbeat evaluation or task spawning until armed.'
        : 'Orchestrator is now active — heartbeat evaluation and task spawning resumed.';
      await db.insert(missionNotes).values({
        missionId: id,
        authorType: 'system',
        type: 'update',
        title: `Orchestration mode set to ${modeLabel}`,
        body: `${modeDesc} (by ${actor})`,
        status: 'open',
      }).catch(e => console.error('[missions/patch] Failed to emit mode-change note:', e));
    }

    return NextResponse.json(updated);
  } catch (error) {
    console.error('Update mission error:', error);
    return NextResponse.json({ error: 'Failed to update mission' }, { status: 500 });
  }
}

// DELETE /api/missions/[id]
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

    const existing = await db.query.missions.findFirst({
      where: eq(missions.id, id),
    });

    if (!existing || !(await hasMissionAccess(existing, teamIds))) {
      return NextResponse.json({ error: 'Mission not found' }, { status: 404 });
    }

    if (existing.scheduleId) {
      await db.delete(taskSchedules).where(eq(taskSchedules.id, existing.scheduleId));
    }

    await db.delete(missions).where(eq(missions.id, id));

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Delete mission error:', error);
    return NextResponse.json({ error: 'Failed to delete mission' }, { status: 500 });
  }
}
