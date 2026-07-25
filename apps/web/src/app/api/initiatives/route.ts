import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { initiatives, workspaces } from '@buildd/core/db/schema';
import { eq, and, inArray, desc } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { getUserTeamIds, resolveAccountTeamIds } from '@/lib/team-access';
import { computeMissionProgress, computeInitiativeProgress, type ChildMissionProgress } from '@buildd/core/mission-helpers';

/**
 * Roll a loaded initiative (with its child missions + their tasks) up into a
 * progress summary. Pure — no DB access; callers pass the loaded relation.
 */
export function rollupInitiative(initiative: {
  missions?: Array<{ status: string; tasks?: any[] }>;
}) {
  const children: ChildMissionProgress[] = (initiative.missions || []).map((m) => {
    const { totalTasks, completedTasks } = computeMissionProgress(m.tasks || []);
    return { status: m.status as ChildMissionProgress['status'], totalTasks, completedTasks };
  });
  return computeInitiativeProgress(children);
}

// GET /api/initiatives — list initiatives for the user's team(s), with rolled-up progress
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
      return NextResponse.json({ initiatives: [] });
    }

    const { searchParams } = new URL(req.url);
    const statusFilter = searchParams.get('status');
    const workspaceIdFilter = searchParams.get('workspaceId');
    const teamIdFilter = searchParams.get('teamId');

    // Scope to a single team when requested. A teamId the caller is not a member
    // of yields an empty list — never another team's initiatives.
    let scopedTeamIds = teamIds;
    if (teamIdFilter) {
      if (!teamIds.includes(teamIdFilter)) {
        return NextResponse.json({ initiatives: [] });
      }
      scopedTeamIds = [teamIdFilter];
    }

    let where = inArray(initiatives.teamId, scopedTeamIds);
    if (statusFilter) {
      where = and(where, eq(initiatives.status, statusFilter as any))!;
    }
    if (workspaceIdFilter) {
      where = and(where, eq(initiatives.workspaceId, workspaceIdFilter))!;
    }

    const results = await db.query.initiatives.findMany({
      where,
      orderBy: [desc(initiatives.priority), desc(initiatives.createdAt)],
      with: {
        workspace: { columns: { id: true, name: true } },
        missions: {
          columns: { id: true, title: true, status: true },
          with: {
            tasks: {
              columns: { id: true, status: true, kind: true, title: true, mode: true, creationSource: true, category: true },
            },
          },
        },
      },
    });

    const initiativesWithProgress = results.map((initiative) => {
      const progress = rollupInitiative(initiative);
      // Strip the heavy task arrays from the list payload; keep a light mission index.
      const missions = (initiative.missions || []).map((m) => ({ id: m.id, title: m.title, status: m.status }));
      return { ...initiative, missions, progress };
    });

    return NextResponse.json({ initiatives: initiativesWithProgress });
  } catch (error) {
    console.error('List initiatives error:', error);
    return NextResponse.json({ error: 'Failed to list initiatives' }, { status: 500 });
  }
}

// POST /api/initiatives — create an initiative
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
    const { title, description, workspaceId, teamId: requestedTeamId, priority, status: requestedStatus, contextArtifactIds } = body;

    if (!title || typeof title !== 'string') {
      return NextResponse.json({ error: 'title is required' }, { status: 400 });
    }

    const validStatuses = ['active', 'paused', 'completed', 'archived'];
    if (requestedStatus !== undefined && !validStatuses.includes(requestedStatus)) {
      return NextResponse.json({ error: `Invalid status: must be one of ${validStatuses.join(', ')}` }, { status: 400 });
    }
    const effectiveStatus: 'active' | 'paused' | 'completed' | 'archived' = requestedStatus || 'active';

    let teamId: string;
    let userTeamIds: string[] = [];
    if (apiAccount) {
      teamId = apiAccount.teamId;
    } else {
      userTeamIds = await getUserTeamIds(user!.id);
      if (userTeamIds.length === 0) {
        return NextResponse.json({ error: 'No team found' }, { status: 400 });
      }
      if (requestedTeamId && userTeamIds.includes(requestedTeamId)) {
        teamId = requestedTeamId;
      } else {
        teamId = userTeamIds[0];
      }
    }

    if (workspaceId) {
      const ws = await db.query.workspaces.findFirst({
        where: eq(workspaces.id, workspaceId),
        columns: { id: true, teamId: true, accessMode: true },
      });
      if (!ws) {
        return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
      }
      if (apiAccount && ws.teamId !== teamId && ws.accessMode !== 'open') {
        return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
      }
      if (!apiAccount && !userTeamIds.includes(ws.teamId)) {
        return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
      }
      // Workspace is the stronger signal — derive team from it
      teamId = ws.teamId;
    }

    const [initiative] = await db
      .insert(initiatives)
      .values({
        teamId,
        title,
        description: description || null,
        workspaceId: workspaceId || null,
        status: effectiveStatus,
        priority: priority || 0,
        contextArtifactIds: contextArtifactIds || [],
        createdByUserId: user?.id || null,
      })
      .returning();

    return NextResponse.json(initiative, { status: 201 });
  } catch (error) {
    console.error('Create initiative error:', error);
    return NextResponse.json({ error: 'Failed to create initiative' }, { status: 500 });
  }
}
