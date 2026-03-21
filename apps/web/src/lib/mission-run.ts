import { db } from '@buildd/core/db';
import { missions, tasks, workspaces } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { buildMissionContext } from '@/lib/mission-context';
import { dispatchNewTask } from '@/lib/task-dispatch';
import { getOrCreateCoordinationWorkspace } from '@/lib/orchestrator-workspace';

export interface RunMissionResult {
  task: typeof tasks.$inferSelect;
}

/**
 * Trigger an immediate planning task for a mission.
 * Builds rich mission context (task history, active tasks, failures, recipe)
 * and creates + dispatches a planning task.
 *
 * Used by both manual run endpoint and auto-start after mission creation.
 */
export async function runMission(
  missionId: string,
  options?: { manualRun?: boolean }
): Promise<RunMissionResult> {
  const mission = await db.query.missions.findFirst({
    where: eq(missions.id, missionId),
    with: { schedule: true },
  });

  if (!mission) {
    throw new Error('Mission not found');
  }

  if (mission.status !== 'active') {
    throw new Error(`Cannot run mission with status: ${mission.status}. Only active missions can be run.`);
  }

  // Resolve workspace: use mission's workspace or auto-create an orchestrator workspace
  const workspaceId = mission.workspaceId
    || (await getOrCreateCoordinationWorkspace(mission.teamId)).id;

  // Get template context from schedule if available
  const templateContext = (mission.schedule as any)?.taskTemplate?.context as Record<string, unknown> | undefined;

  // Build rich mission context
  const missionContext = await buildMissionContext(missionId, templateContext);

  const taskTitle = `Mission: ${mission.title}`;
  const taskDescription = missionContext?.description || mission.description || null;
  const taskContext: Record<string, unknown> = {
    ...(missionContext?.context || {}),
    ...(options?.manualRun ? { manualRun: true } : {}),
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

  return { task };
}
