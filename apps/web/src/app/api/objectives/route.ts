import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { objectives, workspaces, taskSchedules } from '@buildd/core/db/schema';
import { eq, and, inArray, desc } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { getUserTeamIds } from '@/lib/team-access';
import { computeNextRunAt } from '@/lib/schedule-helpers';

// GET /api/objectives — list objectives for the user's team(s)
export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  const apiAccount = await authenticateApiKey(apiKey);

  if (!user && !apiAccount) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Only admin-level API keys can manage objectives
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
      return NextResponse.json({ objectives: [] });
    }

    const { searchParams } = new URL(req.url);
    const statusFilter = searchParams.get('status');
    const workspaceIdFilter = searchParams.get('workspaceId');

    let where = inArray(objectives.teamId, teamIds);
    if (statusFilter) {
      where = and(where, eq(objectives.status, statusFilter as any))!;
    }
    if (workspaceIdFilter) {
      where = and(where, eq(objectives.workspaceId, workspaceIdFilter))!;
    }

    const results = await db.query.objectives.findMany({
      where,
      orderBy: [desc(objectives.priority), desc(objectives.createdAt)],
      with: {
        workspace: { columns: { id: true, name: true } },
        tasks: { columns: { id: true, status: true } },
      },
    });

    // Compute progress for each objective
    const objectivesWithProgress = results.map(obj => {
      const totalTasks = obj.tasks?.length || 0;
      const completedTasks = obj.tasks?.filter(t => t.status === 'completed').length || 0;
      const progress = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;
      return {
        ...obj,
        totalTasks,
        completedTasks,
        progress,
      };
    });

    return NextResponse.json({ objectives: objectivesWithProgress });
  } catch (error) {
    console.error('List objectives error:', error);
    return NextResponse.json({ error: 'Failed to list objectives' }, { status: 500 });
  }
}

// POST /api/objectives — create objective
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
    const { title, description, workspaceId, cronExpression, priority, parentObjectiveId, skillSlugs, recipeId, outputSchema, model,
      isHeartbeat, heartbeatChecklist, activeHoursStart, activeHoursEnd, activeHoursTimezone } = body;

    if (!title) {
      return NextResponse.json({ error: 'title is required' }, { status: 400 });
    }

    // Validate active hours range
    if (activeHoursStart !== undefined && activeHoursStart !== null && (activeHoursStart < 0 || activeHoursStart > 23)) {
      return NextResponse.json({ error: 'activeHoursStart must be between 0 and 23' }, { status: 400 });
    }
    if (activeHoursEnd !== undefined && activeHoursEnd !== null && (activeHoursEnd < 0 || activeHoursEnd > 23)) {
      return NextResponse.json({ error: 'activeHoursEnd must be between 0 and 23' }, { status: 400 });
    }

    // Resolve teamId
    let teamId: string;
    if (apiAccount) {
      teamId = apiAccount.teamId;
    } else {
      const teamIds = await getUserTeamIds(user!.id);
      if (teamIds.length === 0) {
        return NextResponse.json({ error: 'No team found' }, { status: 400 });
      }
      teamId = teamIds[0];
    }

    // Validate workspaceId if provided
    if (workspaceId) {
      const ws = await db.query.workspaces.findFirst({
        where: and(eq(workspaces.id, workspaceId), eq(workspaces.teamId, teamId)),
        columns: { id: true },
      });
      if (!ws) {
        return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
      }
    }

    const [objective] = await db
      .insert(objectives)
      .values({
        teamId,
        title,
        description: description || null,
        workspaceId: workspaceId || null,
        priority: priority || 0,
        parentObjectiveId: parentObjectiveId || null,
        createdByUserId: user?.id || null,
      })
      .returning();

    // Auto-create schedule if cronExpression provided and workspaceId is set
    if (cronExpression && workspaceId) {
      const nextRunAt = computeNextRunAt(cronExpression, 'UTC');
      const templateContext: Record<string, unknown> = {};
      if (skillSlugs?.length) templateContext.skillSlugs = skillSlugs;
      if (recipeId) templateContext.recipeId = recipeId;
      if (outputSchema) templateContext.outputSchema = outputSchema;
      if (model) templateContext.model = model;
      if (isHeartbeat) templateContext.heartbeat = true;
      if (heartbeatChecklist) templateContext.heartbeatChecklist = heartbeatChecklist;
      if (activeHoursStart != null) templateContext.activeHoursStart = activeHoursStart;
      if (activeHoursEnd != null) templateContext.activeHoursEnd = activeHoursEnd;
      if (activeHoursTimezone) templateContext.activeHoursTimezone = activeHoursTimezone;

      const [schedule] = await db
        .insert(taskSchedules)
        .values({
          workspaceId,
          name: `Objective: ${title}`,
          cronExpression,
          timezone: 'UTC',
          taskTemplate: {
            title: `Objective: ${title}`,
            mode: 'planning',
            priority: priority || 0,
            ...(Object.keys(templateContext).length > 0 ? { context: templateContext } : {}),
          },
          nextRunAt,
          createdByUserId: user?.id || null,
        })
        .returning();

      // Store schedule ID back on objective
      await db
        .update(objectives)
        .set({ scheduleId: schedule.id, updatedAt: new Date() })
        .where(eq(objectives.id, objective.id));

      objective.scheduleId = schedule.id;
    }

    // Derive backward-compat fields from schedule template context
    return NextResponse.json({
      ...objective,
      cronExpression: cronExpression || null,
      isHeartbeat: isHeartbeat || false,
      heartbeatChecklist: heartbeatChecklist || null,
      activeHoursStart: activeHoursStart ?? null,
      activeHoursEnd: activeHoursEnd ?? null,
      activeHoursTimezone: activeHoursTimezone || null,
    }, { status: 201 });
  } catch (error) {
    console.error('Create objective error:', error);
    return NextResponse.json({ error: 'Failed to create objective' }, { status: 500 });
  }
}
