import { db } from '@buildd/core/db';
import { missions, tasks, workspaces } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { buildMissionContext } from '@/lib/mission-context';
import { dispatchNewTask } from '@/lib/task-dispatch';
import { getOrCreateCoordinationWorkspace } from '@/lib/orchestrator-workspace';

export interface RunMissionResult {
  task: typeof tasks.$inferSelect;
}

export interface CycleContext {
  cycleNumber: number;
  triggerChainId: string;
  triggerSource: 'cron' | 'manual' | 'retrigger';
}

export interface RunMissionOptions {
  manualRun?: boolean;
  cycleContext?: CycleContext;
}

/**
 * Trigger an immediate planning task for a mission.
 * Builds rich mission context (task history, active tasks, failures, recipe)
 * and creates + dispatches a planning task.
 *
 * Used by manual run endpoint, auto-start after mission creation, and closed-loop re-triggers.
 */
export async function runMission(
  missionId: string,
  options?: RunMissionOptions
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

  // Build cycle context — default to cycle 1 with new chain if not provided
  const cycleCtx: CycleContext = options?.cycleContext || {
    cycleNumber: 1,
    triggerChainId: crypto.randomUUID(),
    triggerSource: options?.manualRun ? 'manual' : 'cron',
  };

  // Build rich mission context (pass cycle info so context builder can surface it)
  const missionContext = await buildMissionContext(missionId, {
    ...templateContext,
    cycleNumber: cycleCtx.cycleNumber,
    triggerChainId: cycleCtx.triggerChainId,
    triggerSource: cycleCtx.triggerSource,
  });

  const taskTitle = `Mission: ${mission.title}`;
  const taskDescription = missionContext?.description || mission.description || null;
  const taskContext: Record<string, unknown> = {
    ...(missionContext?.context || {}),
    ...(options?.manualRun ? { manualRun: true } : {}),
    cycleNumber: cycleCtx.cycleNumber,
    triggerChainId: cycleCtx.triggerChainId,
    triggerSource: cycleCtx.triggerSource,
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
