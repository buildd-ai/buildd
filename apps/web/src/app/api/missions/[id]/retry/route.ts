import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { missions, tasks, workers, workerHeartbeats, teamMembers } from '@buildd/core/db/schema';
import { eq, and, gt, sql } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { getUserTeamIds } from '@/lib/team-access';
import { triggerEvent, channels, events } from '@/lib/pusher';

async function resolveTeamIds(user: any, apiAccount: any): Promise<string[]> {
  if (apiAccount) {
    const ownerMembership = await db.query.teamMembers.findFirst({
      where: and(eq(teamMembers.teamId, apiAccount.teamId), eq(teamMembers.role, 'owner')),
      columns: { userId: true },
    });
    if (ownerMembership?.userId) {
      return getUserTeamIds(ownerMembership.userId);
    }
    return [apiAccount.teamId];
  }
  if (user) return getUserTeamIds(user.id);
  return [];
}

/**
 * POST /api/missions/[id]/retry
 *
 * Retry all failed tasks in a mission.
 * Resets each failed task to pending and broadcasts for worker pickup.
 */
export async function POST(
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
        tasks: {
          columns: { id: true, title: true, description: true, workspaceId: true, status: true, mode: true, priority: true },
        },
      },
    });

    if (!mission || !teamIds.includes(mission.teamId)) {
      return NextResponse.json({ error: 'Mission not found' }, { status: 404 });
    }

    const failedTasks = mission.tasks?.filter(t => t.status === 'failed') || [];

    if (failedTasks.length === 0) {
      return NextResponse.json({ error: 'No failed tasks to retry' }, { status: 400 });
    }

    const failedIds = failedTasks.map(t => t.id);

    // Reset all failed tasks to pending in one query
    await db.update(tasks)
      .set({
        status: 'pending',
        claimedBy: null,
        claimedAt: null,
        expiresAt: null,
        result: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(tasks.missionId, id),
          eq(tasks.status, 'failed'),
        )
      );

    // Broadcast each task for worker pickup
    for (const task of failedTasks) {
      const taskPayload = {
        id: task.id,
        title: task.title,
        description: task.description,
        workspaceId: task.workspaceId,
        status: 'pending' as const,
        mode: task.mode,
        priority: task.priority,
      };
      await triggerEvent(
        channels.workspace(task.workspaceId),
        events.TASK_ASSIGNED,
        { task: taskPayload, targetLocalUiUrl: null }
      );
    }

    // Check runner availability for feedback
    const heartbeatCutoff = new Date(Date.now() - 10 * 60 * 1000);
    const onlineHeartbeats = await db
      .select({
        count: sql<number>`count(*)::int`,
        totalCapacity: sql<number>`coalesce(sum(${workerHeartbeats.maxConcurrentWorkers}), 0)::int`,
        totalActive: sql<number>`coalesce(sum(${workerHeartbeats.activeWorkerCount}), 0)::int`,
      })
      .from(workerHeartbeats)
      .where(gt(workerHeartbeats.lastHeartbeatAt, heartbeatCutoff));

    const { count: onlineRunners } = onlineHeartbeats[0] || { count: 0 };

    const response: Record<string, unknown> = {
      retried: failedIds.length,
      taskIds: failedIds,
      onlineRunners,
    };

    if (onlineRunners === 0) {
      response.warning = 'No workers are currently online to pick up these tasks';
    }

    return NextResponse.json(response);
  } catch (error) {
    console.error('Retry mission tasks error:', error);
    return NextResponse.json({ error: 'Failed to retry tasks' }, { status: 500 });
  }
}
