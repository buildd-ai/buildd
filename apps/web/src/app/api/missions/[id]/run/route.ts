import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { objectives, tasks, taskSchedules, workspaces } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { getUserTeamIds } from '@/lib/team-access';
import { buildObjectiveContext } from '@/lib/objective-context';
import { dispatchNewTask } from '@/lib/task-dispatch';

async function resolveTeamIds(user: any, apiAccount: any): Promise<string[]> {
  if (apiAccount) return [apiAccount.teamId];
  if (user) return getUserTeamIds(user.id);
  return [];
}

/**
 * POST /api/missions/[id]/run
 *
 * Manually trigger an immediate planning task for a mission.
 * Builds rich objective context (task history, active tasks, failures, recipe)
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

    const objective = await db.query.objectives.findFirst({
      where: eq(objectives.id, id),
      with: {
        schedule: true,
      },
    });

    if (!objective || !teamIds.includes(objective.teamId)) {
      return NextResponse.json({ error: 'Mission not found' }, { status: 404 });
    }

    if (!objective.workspaceId) {
      return NextResponse.json(
        { error: 'Mission must have a workspace to create tasks' },
        { status: 400 }
      );
    }

    if (objective.status !== 'active') {
      return NextResponse.json(
        { error: `Cannot run mission with status: ${objective.status}. Only active missions can be run.` },
        { status: 400 }
      );
    }

    // Get template context from schedule if available
    const templateContext = (objective.schedule as any)?.taskTemplate?.context as Record<string, unknown> | undefined;

    // Build rich objective context
    const objContext = await buildObjectiveContext(id, templateContext);

    const taskTitle = `Mission: ${objective.title}`;
    const taskDescription = objContext?.description || objective.description || null;
    const taskContext: Record<string, unknown> = {
      ...(objContext?.context || {}),
      manualRun: true,
    };

    // Get template config for mode/priority from schedule if available
    const template = (objective.schedule as any)?.taskTemplate;

    // Create the planning task
    const [task] = await db
      .insert(tasks)
      .values({
        workspaceId: objective.workspaceId,
        title: taskTitle,
        description: taskDescription,
        priority: template?.priority || objective.priority || 0,
        status: 'pending',
        mode: template?.mode || 'planning',
        runnerPreference: template?.runnerPreference || 'any',
        requiredCapabilities: template?.requiredCapabilities || [],
        context: taskContext,
        creationSource: 'orchestrator',
        objectiveId: objective.id,
      })
      .returning();

    // Dispatch the task
    const workspace = await db.query.workspaces.findFirst({
      where: eq(workspaces.id, objective.workspaceId),
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
