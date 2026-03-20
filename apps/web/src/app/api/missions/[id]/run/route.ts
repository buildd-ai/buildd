import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { missions, tasks, taskSchedules, workspaces } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { getUserTeamIds } from '@/lib/team-access';
import { buildMissionContext } from '@/lib/mission-context';
import { dispatchNewTask } from '@/lib/task-dispatch';
import { getOrCreateCoordinationWorkspace } from '@/lib/orchestrator-workspace';

async function resolveTeamIds(user: any, apiAccount: any): Promise<string[]> {
  if (apiAccount) return [apiAccount.teamId];
  if (user) return getUserTeamIds(user.id);
  return [];
}

/**
 * POST /api/missions/[id]/run
 *
 * Manually trigger an immediate planning task for a mission.
 * Builds rich mission context (task history, active tasks, failures, recipe)
 * and creates + dispatches a planning task.
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
        schedule: true,
      },
    });

    if (!mission || !teamIds.includes(mission.teamId)) {
      return NextResponse.json({ error: 'Mission not found' }, { status: 404 });
    }

    // Resolve workspace: use mission's workspace or auto-create an orchestrator workspace
    const workspaceId = mission.workspaceId
      || (await getOrCreateCoordinationWorkspace(mission.teamId)).id;

    if (mission.status !== 'active') {
      return NextResponse.json(
        { error: `Cannot run mission with status: ${mission.status}. Only active missions can be run.` },
        { status: 400 }
      );
    }

    // Get template context from schedule if available
    const templateContext = (mission.schedule as any)?.taskTemplate?.context as Record<string, unknown> | undefined;

    // Build rich mission context
    const missionContext = await buildMissionContext(id, templateContext);

    const taskTitle = `Mission: ${mission.title}`;
    const taskDescription = missionContext?.description || mission.description || null;
    const taskContext: Record<string, unknown> = {
      ...(missionContext?.context || {}),
      manualRun: true,
    };

    // Get template config for mode/priority from schedule if available
    const template = (mission.schedule as any)?.taskTemplate;

    // Create the planning task
    const [task] = await db
      .insert(tasks)
      .values({
        workspaceId,
        title: taskTitle,
        description: taskDescription,
        priority: template?.priority || mission.priority || 0,
        status: 'pending',
        mode: template?.mode || 'planning',
        runnerPreference: template?.runnerPreference || 'any',
        requiredCapabilities: template?.requiredCapabilities || [],
        context: taskContext,
        creationSource: 'orchestrator',
        missionId: mission.id,
      })
      .returning();

    // Dispatch the task
    const workspace = await db.query.workspaces.findFirst({
      where: eq(workspaces.id, workspaceId),
    });

    if (workspace) {
      await dispatchNewTask(task, workspace);
    }

    return NextResponse.json({ task }, { status: 201 });
  } catch (error) {
    console.error('Run mission error:', error);
    return NextResponse.json({ error: 'Failed to run mission' }, { status: 500 });
  }
}
