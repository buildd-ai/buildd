import { NextRequest, NextResponse, after } from 'next/server';
import { db } from '@buildd/core/db';
import { missions, tasks, taskSchedules, workspaces, missionNotes, initiatives } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { resolveAccountTeamIds } from '@/lib/team-access';
import { computeNextRunAt } from '@/lib/schedule-helpers';
import { computeMissionProgress } from '@buildd/core/mission-helpers';
import { isMissionBlocked, wouldCreateCycle } from '@/lib/mission-dependency';
import { parseMergePolicy } from '@buildd/shared';
import { laterStartAt, resolveDeferredStart } from '@/lib/deferred-start';
import { refreshStaleWorkers } from '@/lib/pr-state-refresh';
import { mergePolicySchema } from '@/lib/merge-policy';

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
          columns: { id: true, title: true, status: true, priority: true, roleSlug: true, createdAt: true, result: true, updatedAt: true, kind: true, mode: true, category: true, parentTaskId: true, creationSource: true },
          orderBy: (tasks, { desc }) => [desc(tasks.createdAt)],
          with: { workers: { columns: { id: true, status: true, prUrl: true, mergedAt: true, prNumber: true, prLifecycleStatus: true, prLastCheckedAt: true }, orderBy: (w: any, { desc }: any) => [desc(w.startedAt)], limit: 1 } },
        },
        subMissions: { columns: { id: true, title: true, status: true } },
        schedule: true,
      },
    });

    if (!mission || !(await hasMissionAccess(mission, teamIds))) {
      return NextResponse.json({ error: 'Mission not found' }, { status: 404 });
    }

    const { totalTasks, completedTasks, progress, segments } = computeMissionProgress(mission.tasks || []);

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

    // Stale-while-revalidate: fire PR state refresh in the background so the
    // open view gets corrected state via WORKER_PROGRESS without blocking render.
    const prCandidates = (mission.tasks || []).flatMap((task: any) =>
      (task.workers || []).map((w: any) => ({
        id: w.id as string,
        prNumber: (w.prNumber ?? null) as number | null,
        workspaceId: mission.workspaceId as string,
        taskId: task.id as string,
        prLifecycleStatus: (w.prLifecycleStatus ?? null) as string | null,
        prLastCheckedAt: (w.prLastCheckedAt ?? null) as Date | null,
      }))
    );
    if (prCandidates.length > 0) {
      try {
        after(() =>
          refreshStaleWorkers(prCandidates).catch(err =>
            console.error('[pr-state-refresh] mission detail refresh failed:', err)
          )
        );
      } catch {
        // after() unavailable outside request scope (tests/build)
      }
    }

    return NextResponse.json({
      ...mission,
      totalTasks,
      completedTasks,
      progress,
      segments,
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
    const { title, description, status, priority, cronExpression, workspaceId, initiativeId, skillSlugs, outputSchema, model,
      isHeartbeat, heartbeatChecklist, activeHoursStart, activeHoursEnd, activeHoursTimezone, maxConcurrentTasks, backend,
      dependsOnMission, gateCondition, mergePolicy, orchestrationMode, externalIssueId, externalIssueUrl, costBudgetUsd,
      pacingMode, pacingMaxPerHour, goalCriteria, autoVerify,
      startAt: rawStartAt, startIn: rawStartIn, startAfter: rawStartAfter,
      startMode, arm } = body;

    if (maxConcurrentTasks !== undefined && maxConcurrentTasks !== null && (!Number.isInteger(maxConcurrentTasks) || maxConcurrentTasks < 1)) {
      return NextResponse.json({ error: 'maxConcurrentTasks must be an integer >= 1' }, { status: 400 });
    }

    if (pacingMode !== undefined && pacingMode !== 'eager' && pacingMode !== 'paced') {
      return NextResponse.json({ error: 'pacingMode must be "eager" or "paced"' }, { status: 400 });
    }

    if (pacingMaxPerHour !== undefined && pacingMaxPerHour !== null && (!Number.isInteger(pacingMaxPerHour) || pacingMaxPerHour < 1)) {
      return NextResponse.json({ error: 'pacingMaxPerHour must be an integer >= 1' }, { status: 400 });
    }

    if (gateCondition !== undefined && gateCondition !== 'merged' && gateCondition !== 'completed') {
      return NextResponse.json({ error: 'gateCondition must be "merged" or "completed"' }, { status: 400 });
    }

    if (mergePolicy !== undefined && mergePolicy !== null) {
      const parsed = parseMergePolicy(mergePolicy);
      if (!parsed.ok) {
        return NextResponse.json({ error: parsed.error, field: parsed.field }, { status: 422 });
      }
    }

    if (orchestrationMode !== undefined && orchestrationMode !== 'auto' && orchestrationMode !== 'manual') {
      return NextResponse.json({ error: 'orchestrationMode must be "auto" or "manual"' }, { status: 400 });
    }

    if (startMode !== undefined && startMode !== 'armed' && startMode !== 'held') {
      return NextResponse.json({ error: 'startMode must be "armed" or "held"' }, { status: 400 });
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

    let updatedStartAt: Date | null | undefined;
    if (rawStartAt !== undefined || rawStartIn !== undefined || rawStartAfter !== undefined) {
      try {
        const resolved = resolveDeferredStart({
          startAt: rawStartAt,
          startIn: rawStartIn,
          startAfter: rawStartAfter,
          knownBudgetResetAt: backend === 'codex' ? null : apiAccount?.budgetResetsAt ?? null,
        });
        updatedStartAt = resolved.startAt;
        updateData.startAt = resolved.startAt;
        updateData.startResolution = resolved.resolution;
      } catch (error) {
        return NextResponse.json({ error: error instanceof Error ? error.message : 'Invalid deferred start' }, { status: 400 });
      }
    }

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
    // Link (or unlink) the mission to an external tracker project/issue.
    if (externalIssueId !== undefined) updateData.externalIssueId = externalIssueId || null;
    if (externalIssueUrl !== undefined) updateData.externalIssueUrl = externalIssueUrl || null;
    if (maxConcurrentTasks !== undefined) updateData.maxConcurrentTasks = maxConcurrentTasks;
    if (workspaceId !== undefined) updateData.workspaceId = workspaceId || null;
    // Assign to / unlink from a parent initiative. null clears the link.
    if (initiativeId !== undefined) {
      if (initiativeId) {
        const init = await db.query.initiatives.findFirst({
          where: eq(initiatives.id, initiativeId),
          columns: { id: true, teamId: true },
        });
        if (!init || init.teamId !== existing.teamId) {
          return NextResponse.json({ error: 'initiative not found' }, { status: 404 });
        }
      }
      updateData.initiativeId = initiativeId || null;
    }
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
    if (mergePolicy !== undefined) {
      if (mergePolicy !== null) {
        const result = mergePolicySchema.safeParse(mergePolicy);
        if (!result.success) {
          const msg = result.error.issues[0]?.message ?? 'invalid';
          const path = result.error.issues[0]?.path.join('.') ?? '';
          return NextResponse.json(
            { error: `mergePolicy${path ? `.${path}` : ''}: ${msg}` },
            { status: 400 },
          );
        }
        updateData.mergePolicy = result.data;
      } else {
        updateData.mergePolicy = null;
      }
    }
    if (orchestrationMode !== undefined) {
      updateData.orchestrationMode = orchestrationMode;
    }
    if (costBudgetUsd !== undefined) {
      updateData.costBudgetUsd = costBudgetUsd != null ? String(costBudgetUsd) : null;
      // Auto-resume: raising the budget on a budget_exhausted mission resumes it
      if (costBudgetUsd != null && existing.status === 'budget_exhausted') {
        const existingBudget = existing.costBudgetUsd != null ? parseFloat(existing.costBudgetUsd as string) : null;
        if (existingBudget === null || costBudgetUsd > existingBudget) {
          updateData.status = 'active';
        }
      }
    }
    if (pacingMode !== undefined) updateData.pacingMode = pacingMode;
    if (pacingMaxPerHour !== undefined) updateData.pacingMaxPerHour = pacingMaxPerHour ?? null;
    // startMode: 'held' → isHeld=true (workers cannot claim tasks); 'armed' → isHeld=false.
    // arm: true is shorthand for startMode='armed'.
    if (arm === true) {
      updateData.isHeld = false;
    } else if (startMode !== undefined) {
      updateData.isHeld = startMode === 'held';
    }

    if (goalCriteria !== undefined) {
      if (goalCriteria !== null) {
        if (!Array.isArray(goalCriteria)) {
          return NextResponse.json({ error: 'goalCriteria must be an array' }, { status: 400 });
        }
        if (goalCriteria.length > 20) {
          return NextResponse.json({ error: 'goalCriteria must have at most 20 criteria' }, { status: 400 });
        }
        const VALID_CRITERION_TYPES = ['all_prs_merged', 'command', 'no_open_tasks', 'artifact_exists', 'metric', 'description'];
        for (let i = 0; i < goalCriteria.length; i++) {
          const c = goalCriteria[i];
          if (typeof c !== 'object' || c === null || Array.isArray(c)) {
            return NextResponse.json({ error: `goalCriteria[${i}] must be an object` }, { status: 400 });
          }
          if (!VALID_CRITERION_TYPES.includes((c as any).type)) {
            return NextResponse.json({ error: `goalCriteria[${i}].type must be one of: ${VALID_CRITERION_TYPES.join(', ')}` }, { status: 400 });
          }
        }
      }
      updateData.goalCriteria = goalCriteria ?? null;
    }
    if (autoVerify !== undefined) {
      updateData.autoVerify = autoVerify === true ? true : autoVerify === false ? false : null;
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
          const nextRunAt = updatedStartAt !== undefined
            ? (updatedStartAt ?? (effectiveCron ? computeNextRunAt(effectiveCron, 'UTC') : null))
            : cronExpression !== undefined
              ? computeNextRunAt(cronExpression, 'UTC')
              : undefined;
          await db
            .update(taskSchedules)
            .set({
              ...(cronExpression !== undefined ? { cronExpression } : {}),
              ...(nextRunAt !== undefined ? { nextRunAt: laterStartAt(nextRunAt, updatedStartAt) } : {}),
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

    if (updatedStartAt !== undefined && existing.scheduleId && !scheduleNeedsUpdate) {
      let nextRunAt = updatedStartAt;
      if (nextRunAt === null) {
        const schedule = await db.query.taskSchedules.findFirst({
          where: eq(taskSchedules.id, existing.scheduleId),
          columns: { cronExpression: true },
        });
        nextRunAt = schedule ? computeNextRunAt(schedule.cronExpression, 'UTC') : null;
      }
      await db.update(taskSchedules)
        .set({ nextRunAt, updatedAt: new Date() })
        .where(eq(taskSchedules.id, existing.scheduleId));
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

    // Emit audit note when held state changes
    if (updateData.isHeld !== undefined && updateData.isHeld !== existing.isHeld) {
      const actor = user?.id ? `user ${user.id}` : 'API caller';
      const held = updateData.isHeld;
      await db.insert(missionNotes).values({
        missionId: id,
        authorType: 'system',
        type: 'update',
        title: held ? 'Mission held' : 'Mission armed',
        body: held
          ? `Tasks under this mission are now held — workers will not claim them until armed. (by ${actor})`
          : `Mission armed — tasks are now claimable by workers. (by ${actor})`,
        status: 'open',
      }).catch(e => console.error('[missions/patch] Failed to emit held-state note:', e));
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
