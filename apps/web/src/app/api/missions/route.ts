import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { missions, workspaces, taskSchedules } from '@buildd/core/db/schema';
import { eq, and, inArray, desc } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { getUserTeamIds, resolveAccountTeamIds } from '@/lib/team-access';
import { computeNextRunAt } from '@/lib/schedule-helpers';
import { runMission } from '@/lib/mission-run';
import { computeMissionProgress } from '@buildd/core/mission-helpers';
import {
  DEFAULT_HEARTBEAT_CRON,
  DEFAULT_MISSION_HEARTBEAT_CHECKLIST,
} from '@/lib/heartbeat-helpers';
import { wouldCreateCycle } from '@/lib/mission-dependency';
import { maybePostWorkTrackerNote } from '@/lib/work-tracker';
import { laterStartAt, resolveDeferredStart } from '@/lib/deferred-start';

// GET /api/missions — list missions for the user's team(s)
export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  const apiAccount = await authenticateApiKey(apiKey);

  if (!user && !apiAccount) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const teamIds = await resolveAccountTeamIds(user, apiAccount);

    if (teamIds.length === 0) {
      return NextResponse.json({ missions: [] });
    }

    const { searchParams } = new URL(req.url);
    const statusFilter = searchParams.get('status');
    const workspaceIdFilter = searchParams.get('workspaceId');
    const teamIdFilter = searchParams.get('teamId');

    // Scope to a single team when requested. A teamId the caller is not a member
    // of yields an empty list — never another team's missions.
    let scopedTeamIds = teamIds;
    if (teamIdFilter) {
      if (!teamIds.includes(teamIdFilter)) {
        return NextResponse.json({ missions: [] });
      }
      scopedTeamIds = [teamIdFilter];
    }

    let where = inArray(missions.teamId, scopedTeamIds);
    if (statusFilter) {
      where = and(where, eq(missions.status, statusFilter as any))!;
    }
    if (workspaceIdFilter) {
      where = and(where, eq(missions.workspaceId, workspaceIdFilter))!;
    }

    const results = await db.query.missions.findMany({
      where,
      orderBy: [desc(missions.priority), desc(missions.createdAt)],
      with: {
        workspace: { columns: { id: true, name: true } },
        tasks: {
          columns: { id: true, status: true, kind: true, title: true, creationSource: true },
          with: { workers: { columns: { id: true, status: true, prUrl: true, mergedAt: true }, orderBy: (w: any, { desc }: any) => [desc(w.startedAt)], limit: 1 } },
        },
        schedule: { columns: { cronExpression: true, nextRunAt: true, lastRunAt: true, lastDeferralReason: true, lastDeferredAt: true } },
      },
    });

    const missionsWithProgress = results.map(mission => {
      const { totalTasks, completedTasks, progress, segments } = computeMissionProgress(mission.tasks || []);
      const activeAgents = mission.tasks?.reduce((count, t) =>
        count + (t.workers?.filter((w: any) => w.status === 'running').length || 0), 0) || 0;
      const cronExpression = (mission as any).schedule?.cronExpression ?? null;
      const lastRunAt = (mission as any).schedule?.lastRunAt ?? null;
      const nextRunAt = (mission as any).schedule?.nextRunAt ?? null;
      const lastDeferralReason = (mission as any).schedule?.lastDeferralReason ?? null;
      const lastDeferredAt = (mission as any).schedule?.lastDeferredAt ?? null;
      return {
        ...mission,
        totalTasks,
        completedTasks,
        progress,
        segments,
        activeAgents,
        cronExpression,
        lastRunAt,
        nextRunAt,
        lastDeferralReason,
        lastDeferredAt,
      };
    });

    return NextResponse.json({ missions: missionsWithProgress });
  } catch (error) {
    console.error('List missions error:', error);
    return NextResponse.json({ error: 'Failed to list missions' }, { status: 500 });
  }
}

// POST /api/missions — create mission
export async function POST(req: NextRequest) {
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
    const body = await req.json();
    const { title, description, workspaceId, teamId: requestedTeamId, cronExpression, priority, parentMissionId, skillSlugs, outputSchema, model,
      isHeartbeat, heartbeatChecklist, activeHoursStart, activeHoursEnd, activeHoursTimezone, contextArtifactIds, maxConcurrentTasks, requiresReview, backend,
      status: requestedStatus, dependsOnMission, gateCondition, mergePolicy, orchestrationMode, costBudgetUsd,
      startAt: rawStartAt, startIn: rawStartIn, startAfter: rawStartAfter } = body;

    let deferredStart;
    try {
      deferredStart = resolveDeferredStart({
        startAt: rawStartAt,
        startIn: rawStartIn,
        startAfter: rawStartAfter,
        knownBudgetResetAt: backend === 'codex' ? null : apiAccount?.budgetResetsAt ?? null,
      });
    } catch (error) {
      return NextResponse.json({ error: error instanceof Error ? error.message : 'Invalid deferred start' }, { status: 400 });
    }

    const validStatuses = ['active', 'paused', 'completed', 'archived'];
    if (requestedStatus !== undefined && !validStatuses.includes(requestedStatus)) {
      return NextResponse.json({ error: `Invalid status: must be one of ${validStatuses.join(', ')}` }, { status: 400 });
    }
    const effectiveStatus: 'active' | 'paused' | 'completed' | 'archived' = requestedStatus || 'active';

    const validOrchestrationModes = ['auto', 'manual'];
    if (orchestrationMode !== undefined && !validOrchestrationModes.includes(orchestrationMode)) {
      return NextResponse.json({ error: `Invalid orchestrationMode: must be "auto" or "manual"` }, { status: 400 });
    }
    const effectiveOrchestrationMode: 'auto' | 'manual' = orchestrationMode || 'auto';

    if (!title) {
      return NextResponse.json({ error: 'title is required' }, { status: 400 });
    }

    const defaultBackend: 'claude' | 'codex' | null =
      backend === 'claude' || backend === 'codex' ? backend : null;

    if (maxConcurrentTasks !== undefined && maxConcurrentTasks !== null && (!Number.isInteger(maxConcurrentTasks) || maxConcurrentTasks < 1)) {
      return NextResponse.json({ error: 'maxConcurrentTasks must be an integer >= 1' }, { status: 400 });
    }

    if (gateCondition !== undefined && gateCondition !== 'merged' && gateCondition !== 'completed') {
      return NextResponse.json({ error: 'gateCondition must be "merged" or "completed"' }, { status: 400 });
    }

    if (activeHoursStart !== undefined && activeHoursStart !== null && (activeHoursStart < 0 || activeHoursStart > 23)) {
      return NextResponse.json({ error: 'activeHoursStart must be between 0 and 23' }, { status: 400 });
    }
    if (activeHoursEnd !== undefined && activeHoursEnd !== null && (activeHoursEnd < 0 || activeHoursEnd > 23)) {
      return NextResponse.json({ error: 'activeHoursEnd must be between 0 and 23' }, { status: 400 });
    }

    let teamId: string;
    let userTeamIds: string[] = [];
    if (apiAccount) {
      teamId = apiAccount.teamId;
    } else {
      userTeamIds = await getUserTeamIds(user!.id);
      if (userTeamIds.length === 0) {
        return NextResponse.json({ error: 'No team found' }, { status: 400 });
      }
      // Use requested teamId if provided and user belongs to that team
      if (requestedTeamId && userTeamIds.includes(requestedTeamId)) {
        teamId = requestedTeamId;
      } else {
        teamId = userTeamIds[0];
      }
    }

    if (workspaceId) {
      // Look up workspace without team filter — then verify user has access
      const ws = await db.query.workspaces.findFirst({
        where: eq(workspaces.id, workspaceId),
        columns: { id: true, teamId: true, accessMode: true },
      });
      if (!ws) {
        return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
      }
      // For API key auth, workspace must belong to the account's team or be open-access
      // For session auth, workspace must belong to one of the user's teams
      if (apiAccount && ws.teamId !== teamId && ws.accessMode !== 'open') {
        return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
      }
      if (!apiAccount && !userTeamIds.includes(ws.teamId)) {
        return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
      }
      // Workspace is the stronger signal — derive team from it
      teamId = ws.teamId;
    }

    // Cycle guard for dependency chain
    if (dependsOnMission) {
      // We don't have the new mission's ID yet — no cycle possible on create since it's new.
      // But we still validate that the upstream mission exists in the same team.
      const upstream = await db.query.missions.findFirst({
        where: eq(missions.id, dependsOnMission),
        columns: { id: true, teamId: true },
      });
      if (!upstream || upstream.teamId !== teamId) {
        return NextResponse.json({ error: 'dependsOnMission not found' }, { status: 404 });
      }
    }

    const [mission] = await db
      .insert(missions)
      .values({
        teamId,
        title,
        description: description || null,
        workspaceId: workspaceId || null,
        status: effectiveStatus,
        priority: priority || 0,
        parentMissionId: parentMissionId || null,
        contextArtifactIds: contextArtifactIds || [],
        maxConcurrentTasks: maxConcurrentTasks ?? null,
        createdByUserId: user?.id || null,
        orchestrationMode: effectiveOrchestrationMode,
        ...(defaultBackend ? { defaultBackend } : {}),
        ...(requiresReview === true ? { requiresReview: true } : {}),
        ...(dependsOnMission ? { dependsOnMissionId: dependsOnMission, gateCondition: gateCondition || 'merged' } : {}),
        ...(mergePolicy != null ? { mergePolicy } : {}),
        ...(costBudgetUsd != null ? { costBudgetUsd: String(costBudgetUsd) } : {}),
        ...(deferredStart.startAt ? {
          startAt: deferredStart.startAt,
          startResolution: deferredStart.resolution,
        } : {}),
      })
      .returning();

    // UI-created missions (session auth, no explicit cron/heartbeat) run once — no auto-heartbeat.
    // API-created missions keep existing default (heartbeat ON) for backward compat.
    const uiCreated = !apiAccount && !cronExpression && isHeartbeat === undefined;
    const effectiveHeartbeat = uiCreated ? false : (isHeartbeat !== false);
    const effectiveCron = cronExpression || (effectiveHeartbeat ? DEFAULT_HEARTBEAT_CRON : null);

    if (effectiveCron) {
      const nextRunAt = laterStartAt(computeNextRunAt(effectiveCron, 'UTC'), deferredStart.startAt);
      const templateContext: Record<string, unknown> = {};
      if (skillSlugs?.length) templateContext.skillSlugs = skillSlugs;
      if (outputSchema) templateContext.outputSchema = outputSchema;
      if (model) templateContext.model = model;
      if (effectiveHeartbeat) {
        templateContext.heartbeat = true;
        templateContext.heartbeatChecklist = heartbeatChecklist || DEFAULT_MISSION_HEARTBEAT_CHECKLIST;
      }
      if (activeHoursStart != null) templateContext.activeHoursStart = activeHoursStart;
      if (activeHoursEnd != null) templateContext.activeHoursEnd = activeHoursEnd;
      if (activeHoursTimezone) templateContext.activeHoursTimezone = activeHoursTimezone;

      const [schedule] = await db
        .insert(taskSchedules)
        .values({
          workspaceId: workspaceId || null,
          name: `Mission: ${title}`,
          cronExpression: effectiveCron,
          timezone: 'UTC',
          taskTemplate: {
            title: `Mission: ${title}`,
            mode: 'planning',
            priority: priority || 0,
            ...(Object.keys(templateContext).length > 0 ? { context: templateContext } : {}),
          },
          nextRunAt,
          createdByUserId: user?.id || null,
        })
        .returning();

      await db
        .update(missions)
        .set({ scheduleId: schedule.id, updatedAt: new Date() })
        .where(eq(missions.id, mission.id));

      mission.scheduleId = schedule.id;
    }

    // Auto-start the organizer only when the mission is born active, heartbeat is not disabled,
    // and orchestrationMode is 'auto'. Manual-mode missions require explicit human trigger.
    let organizerTask: { id: string } | null = null;
    if (effectiveStatus === 'active' && isHeartbeat !== false && effectiveOrchestrationMode === 'auto' && !deferredStart.startAt) {
      try {
        const result = await runMission(mission.id, { manualRun: true });
        if (result.task) organizerTask = { id: result.task.id };
      } catch (err) {
        console.error('Auto-start organizer failed (mission still created):', err);
      }
    }

    // Non-blocking: post a work-tracker suggestion note if the workspace has one configured
    if (workspaceId) {
      maybePostWorkTrackerNote(mission.id, workspaceId).catch(() => {});
    }

    // Build informative creation response
    const nextRunInfo = mission.scheduleId
      ? (() => {
          // Best-effort: include nextRunAt from the schedule we just created
          return effectiveOrchestrationMode === 'manual'
            ? 'Schedule configured but dormant — orchestrationMode is manual'
            : `Heartbeat enabled`;
        })()
      : null;

    return NextResponse.json(
      {
        ...mission,
        organizerTask,
        ...(deferredStart.startAt ? {
          startAt: deferredStart.startAt.toISOString(),
          startResolution: deferredStart.resolution,
        } : {}),
        ...(nextRunInfo ? { heartbeatInfo: nextRunInfo } : {}),
      },
      { status: 201 }
    );
  } catch (error) {
    console.error('Create mission error:', error);
    return NextResponse.json({ error: 'Failed to create mission' }, { status: 500 });
  }
}
