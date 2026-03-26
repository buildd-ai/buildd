import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { missions, workspaces, taskSchedules } from '@buildd/core/db/schema';
import { eq, and, inArray, desc } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { getUserTeamIds } from '@/lib/team-access';
import { computeNextRunAt } from '@/lib/schedule-helpers';
import { runMission } from '@/lib/mission-run';
import {
  DEFAULT_HEARTBEAT_CRON,
  DEFAULT_ACTIVE_HOURS_START,
  DEFAULT_ACTIVE_HOURS_END,
  DEFAULT_ACTIVE_HOURS_TIMEZONE,
  DEFAULT_MISSION_HEARTBEAT_CHECKLIST,
} from '@/lib/heartbeat-helpers';

// GET /api/missions — list missions for the user's team(s)
export async function GET(req: NextRequest) {
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
    let teamIds: string[] = [];
    if (apiAccount) {
      teamIds = [apiAccount.teamId];
    } else {
      teamIds = await getUserTeamIds(user!.id);
    }

    if (teamIds.length === 0) {
      return NextResponse.json({ missions: [] });
    }

    const { searchParams } = new URL(req.url);
    const statusFilter = searchParams.get('status');
    const workspaceIdFilter = searchParams.get('workspaceId');

    let where = inArray(missions.teamId, teamIds);
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
        tasks: { columns: { id: true, status: true } },
      },
    });

    const missionsWithProgress = results.map(mission => {
      const totalTasks = mission.tasks?.length || 0;
      const completedTasks = mission.tasks?.filter(t => t.status === 'completed').length || 0;
      const progress = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;
      return {
        ...mission,
        totalTasks,
        completedTasks,
        progress,
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
    const { title, description, workspaceId, teamId: requestedTeamId, cronExpression, priority, parentMissionId, skillSlugs, recipeId, outputSchema, model,
      isHeartbeat, heartbeatChecklist, activeHoursStart, activeHoursEnd, activeHoursTimezone } = body;

    if (!title) {
      return NextResponse.json({ error: 'title is required' }, { status: 400 });
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
        columns: { id: true, teamId: true },
      });
      if (!ws) {
        return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
      }
      // For API key auth, workspace must belong to the account's team
      // For session auth, workspace must belong to one of the user's teams
      if (apiAccount && ws.teamId !== teamId) {
        return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
      }
      if (!apiAccount && !userTeamIds.includes(ws.teamId)) {
        return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
      }
      // Workspace is the stronger signal — derive team from it
      teamId = ws.teamId;
    }

    const [mission] = await db
      .insert(missions)
      .values({
        teamId,
        title,
        description: description || null,
        workspaceId: workspaceId || null,
        priority: priority || 0,
        parentMissionId: parentMissionId || null,
        createdByUserId: user?.id || null,
      })
      .returning();

    // Auto-create schedule: heartbeat is ON by default unless explicitly opted out.
    // If caller provides cronExpression, use it. Otherwise, default to heartbeat cron.
    const effectiveHeartbeat = isHeartbeat !== false;
    const effectiveCron = cronExpression || (effectiveHeartbeat ? DEFAULT_HEARTBEAT_CRON : null);

    if (effectiveCron) {
      const nextRunAt = computeNextRunAt(effectiveCron, 'UTC');
      const templateContext: Record<string, unknown> = {};
      if (skillSlugs?.length) templateContext.skillSlugs = skillSlugs;
      if (recipeId) templateContext.recipeId = recipeId;
      if (outputSchema) templateContext.outputSchema = outputSchema;
      if (model) templateContext.model = model;
      if (effectiveHeartbeat) {
        templateContext.heartbeat = true;
        templateContext.heartbeatChecklist = heartbeatChecklist || DEFAULT_MISSION_HEARTBEAT_CHECKLIST;
        templateContext.activeHoursStart = activeHoursStart ?? DEFAULT_ACTIVE_HOURS_START;
        templateContext.activeHoursEnd = activeHoursEnd ?? DEFAULT_ACTIVE_HOURS_END;
        templateContext.activeHoursTimezone = activeHoursTimezone || DEFAULT_ACTIVE_HOURS_TIMEZONE;
      } else {
        // Explicit cron without heartbeat — just pass through what was provided
        if (activeHoursStart != null) templateContext.activeHoursStart = activeHoursStart;
        if (activeHoursEnd != null) templateContext.activeHoursEnd = activeHoursEnd;
        if (activeHoursTimezone) templateContext.activeHoursTimezone = activeHoursTimezone;
      }

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

    // Auto-start the organizer: create and dispatch a planning task immediately.
    // Fire-and-forget — mission creation succeeds even if the organizer fails to start.
    let organizerTask: { id: string } | null = null;
    try {
      const result = await runMission(mission.id);
      organizerTask = { id: result.task.id };
    } catch (err) {
      console.error('Auto-start organizer failed (mission still created):', err);
    }

    return NextResponse.json(
      { ...mission, organizerTask },
      { status: 201 }
    );
  } catch (error) {
    console.error('Create mission error:', error);
    return NextResponse.json({ error: 'Failed to create mission' }, { status: 500 });
  }
}
