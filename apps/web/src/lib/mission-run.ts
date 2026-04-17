import { db } from '@buildd/core/db';
import { missions, tasks, workspaces } from '@buildd/core/db/schema';
import { eq, and, not, isNotNull, inArray, sql } from 'drizzle-orm';
import { buildMissionContext as _buildMissionContext } from '@/lib/mission-context';
import { dispatchNewTask as _dispatchNewTask } from '@/lib/task-dispatch';
import { getOrCreateCoordinationWorkspace as _getOrCreateCoordinationWorkspace } from '@/lib/orchestrator-workspace';

export interface RunMissionResult {
  task: typeof tasks.$inferSelect;
  /** True when an in-flight planning task was returned instead of creating a new one */
  deduped?: boolean;
}

export interface CycleContext {
  cycleNumber: number;
  triggerChainId: string;
  triggerSource: 'cron' | 'manual' | 'retrigger' | 'auto_retry';
}

export interface RunMissionOptions {
  manualRun?: boolean;
  cycleContext?: CycleContext;
  /** Corrective feedback from the retrigger loop when a planning cycle created 0 tasks */
  stuckPlanningFeedback?: string;
}

/** Overridable deps for testing without mock.module pollution */
export interface RunMissionDeps {
  buildMissionContext?: typeof _buildMissionContext;
  dispatchNewTask?: typeof _dispatchNewTask;
  getOrCreateCoordinationWorkspace?: typeof _getOrCreateCoordinationWorkspace;
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
  options?: RunMissionOptions,
  deps?: RunMissionDeps,
): Promise<RunMissionResult> {
  const buildMissionContext = deps?.buildMissionContext ?? _buildMissionContext;
  const dispatchNewTask = deps?.dispatchNewTask ?? _dispatchNewTask;
  const getOrCreateCoordinationWorkspace = deps?.getOrCreateCoordinationWorkspace ?? _getOrCreateCoordinationWorkspace;

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

  // Dedupe: if a planning task for this mission is already in-flight, return it
  // instead of creating another. Prevents double-runs from stale client state (e.g.
  // iOS Pusher missing a cron-fired run, user taps Run, two parallel planners start).
  // Safe for other callers: cron path creates tasks directly (not via runMission),
  // retrigger runs only after the prior planner is in a terminal state, and mission
  // auto-start happens at creation when no tasks exist yet.
  const inFlight = await db.query.tasks.findFirst({
    where: and(
      eq(tasks.missionId, missionId),
      eq(tasks.mode, 'planning'),
      inArray(tasks.status, ['pending', 'assigned', 'in_progress']),
    ),
    orderBy: (t, { desc }) => [desc(t.createdAt)],
  });
  if (inFlight) {
    return { task: inFlight, deduped: true };
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
    triggerSource: 'manual',
  };

  // Build rich mission context (pass cycle info so context builder can surface it)
  const missionContext = await buildMissionContext(missionId, {
    ...templateContext,
    cycleNumber: cycleCtx.cycleNumber,
    triggerChainId: cycleCtx.triggerChainId,
    triggerSource: cycleCtx.triggerSource,
  });

  const taskTitle = `Mission: ${mission.title}`;
  let taskDescription = missionContext?.description || mission.description || null;
  if (options?.stuckPlanningFeedback && taskDescription) {
    taskDescription = `> **System Feedback**: ${options.stuckPlanningFeedback}\n\n${taskDescription}`;
  }
  const taskContext: Record<string, unknown> = {
    ...(missionContext?.context || {}),
    ...(options?.manualRun ? { manualRun: true } : {}),
    ...(options?.stuckPlanningFeedback ? { stuckPlanningFeedback: options.stuckPlanningFeedback } : {}),
    cycleNumber: cycleCtx.cycleNumber,
    triggerChainId: cycleCtx.triggerChainId,
    triggerSource: cycleCtx.triggerSource,
  };

  // Get template config for mode/priority from schedule if available
  const template = (mission.schedule as any)?.taskTemplate;

  // Derive heartbeat role from mission's dominant child task role
  // (first heartbeat with no tasks yet falls back to organizer)
  let roleSlug = template?.roleSlug || 'organizer';
  if (roleSlug === 'organizer') {
    const dominantRole = await db
      .select({ roleSlug: tasks.roleSlug, count: sql<number>`count(*)::int` })
      .from(tasks)
      .where(and(
        eq(tasks.missionId, mission.id),
        not(eq(tasks.mode, 'planning')),
        isNotNull(tasks.roleSlug),
      ))
      .groupBy(tasks.roleSlug)
      .orderBy(sql`count(*) desc`)
      .limit(1);
    if (dominantRole[0]?.roleSlug) {
      roleSlug = dominantRole[0].roleSlug;
    }
  }

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
      roleSlug,
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
