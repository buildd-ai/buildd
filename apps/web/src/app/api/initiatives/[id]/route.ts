import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { initiatives, artifacts, workspaces } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { resolveAccountTeamIds } from '@/lib/team-access';
import { computeMissionProgress, computeInitiativeProgress, type ChildMissionProgress } from '@buildd/core/mission-helpers';

/** Check if an initiative is accessible: team match OR open-access workspace. */
async function hasInitiativeAccess(initiative: { teamId: string; workspaceId: string | null }, teamIds: string[]): Promise<boolean> {
  if (teamIds.includes(initiative.teamId)) return true;
  if (initiative.workspaceId) {
    const ws = await db.query.workspaces.findFirst({
      where: eq(workspaces.id, initiative.workspaceId),
      columns: { accessMode: true },
    });
    if (ws?.accessMode === 'open') return true;
  }
  return false;
}

// GET /api/initiatives/[id] — initiative + child missions (each with progress) + rollup
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

  try {
    const teamIds = await resolveAccountTeamIds(user, apiAccount);

    const initiative = await db.query.initiatives.findFirst({
      where: eq(initiatives.id, id),
      with: {
        workspace: { columns: { id: true, name: true } },
        missions: {
          columns: { id: true, title: true, status: true, priority: true, workspaceId: true, updatedAt: true },
          with: {
            tasks: {
              columns: { id: true, status: true, kind: true, title: true, mode: true, creationSource: true, category: true },
              with: { workers: { columns: { id: true, status: true, prUrl: true, mergedAt: true }, orderBy: (w: any, { desc }: any) => [desc(w.startedAt)], limit: 1 } },
            },
          },
        },
      },
    });

    if (!initiative || !(await hasInitiativeAccess(initiative, teamIds))) {
      return NextResponse.json({ error: 'Initiative not found' }, { status: 404 });
    }

    const children: ChildMissionProgress[] = [];
    const missionsWithProgress = (initiative.missions || []).map((m) => {
      const { totalTasks, completedTasks, progress, segments } = computeMissionProgress(m.tasks || []);
      children.push({ status: m.status as ChildMissionProgress['status'], totalTasks, completedTasks });
      const { tasks, ...missionRest } = m as any;
      return { ...missionRest, totalTasks, completedTasks, progress, segments };
    });
    const progress = computeInitiativeProgress(children);

    // Initiative-level artifacts (roadmap/spec not tied to a specific mission).
    const initiativeArtifacts = await db.query.artifacts.findMany({
      where: eq(artifacts.initiativeId, id),
    });

    return NextResponse.json({
      ...initiative,
      missions: missionsWithProgress,
      progress,
      artifacts: initiativeArtifacts,
    });
  } catch (error) {
    console.error('Get initiative error:', error);
    return NextResponse.json({ error: 'Failed to get initiative' }, { status: 500 });
  }
}

// PATCH /api/initiatives/[id]
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
    const teamIds = await resolveAccountTeamIds(user, apiAccount);

    const existing = await db.query.initiatives.findFirst({ where: eq(initiatives.id, id) });
    if (!existing || !(await hasInitiativeAccess(existing, teamIds))) {
      return NextResponse.json({ error: 'Initiative not found' }, { status: 404 });
    }

    const body = await req.json();
    const { title, description, status, priority, workspaceId, contextArtifactIds } = body;

    const updateData: Partial<typeof initiatives.$inferInsert> = { updatedAt: new Date() };

    if (title !== undefined) {
      if (!title || typeof title !== 'string') {
        return NextResponse.json({ error: 'title must be a non-empty string' }, { status: 400 });
      }
      updateData.title = title;
    }
    if (description !== undefined) updateData.description = description || null;
    if (status !== undefined) {
      const validStatuses = ['active', 'paused', 'completed', 'archived'];
      if (!validStatuses.includes(status)) {
        return NextResponse.json({ error: `Invalid status. Must be one of: ${validStatuses.join(', ')}` }, { status: 400 });
      }
      updateData.status = status;
    }
    if (priority !== undefined) updateData.priority = priority;
    if (workspaceId !== undefined) updateData.workspaceId = workspaceId || null;
    if (contextArtifactIds !== undefined) updateData.contextArtifactIds = contextArtifactIds || [];

    const [updated] = await db
      .update(initiatives)
      .set(updateData)
      .where(eq(initiatives.id, id))
      .returning();

    return NextResponse.json(updated);
  } catch (error) {
    console.error('Update initiative error:', error);
    return NextResponse.json({ error: 'Failed to update initiative' }, { status: 500 });
  }
}

// DELETE /api/initiatives/[id] — deletes the initiative only. Child missions and
// artifacts have onDelete: 'set null' FKs, so they are unlinked, never deleted.
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
    const teamIds = await resolveAccountTeamIds(user, apiAccount);

    const existing = await db.query.initiatives.findFirst({ where: eq(initiatives.id, id) });
    if (!existing || !(await hasInitiativeAccess(existing, teamIds))) {
      return NextResponse.json({ error: 'Initiative not found' }, { status: 404 });
    }

    await db.delete(initiatives).where(eq(initiatives.id, id));

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Delete initiative error:', error);
    return NextResponse.json({ error: 'Failed to delete initiative' }, { status: 500 });
  }
}
