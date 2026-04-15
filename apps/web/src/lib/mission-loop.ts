import { db } from '@buildd/core/db';
import { missions, tasks, taskSchedules } from '@buildd/core/db/schema';
import { eq, and, sql, desc, gt } from 'drizzle-orm';
import { triggerEvent, channels, events } from '@/lib/pusher';
import type { CycleContext, RunMissionOptions, RunMissionResult } from '@/lib/mission-run';

/** Max planning cycles within a single trigger chain before stopping */
const MAX_CYCLES_PER_CHAIN = 5;

/** Debounce window (ms) to prevent concurrent re-triggers */
const DEBOUNCE_MS = 10_000;

export type LoopAction = 'retriggered' | 'completed' | 'stalled' | 'depth_exceeded' | 'skipped' | 'evaluation_requested' | 'failure_retried' | 'failure_limit';

/**
 * Evaluate whether a mission should start another planning cycle after
 * an aggregation task (or zero-child planning task) completes.
 *
 * Runs a guard chain: status → heartbeat → idempotency → completion → depth → stall.
 * If all guards pass, calls runMission() with incremented cycle context.
 *
 * This function is fire-and-forget from the caller — errors are logged, not thrown.
 */
type RunMissionFn = (id: string, opts?: RunMissionOptions) => Promise<RunMissionResult>;
type SpawnEvaluationFn = (missionId: string, completedTaskId: string) => Promise<string | null>;

export async function maybeRetriggerMission(
  missionId: string,
  completedPlanningTaskId: string,
  /** Injected for testing — defaults to the real runMission */
  _runMission?: RunMissionFn,
  /** Injected for testing — defaults to the real spawnEvaluationTask */
  _spawnEvaluation?: SpawnEvaluationFn,
): Promise<{ action: LoopAction }> {
  // 1. Mission status check
  const mission = await db.query.missions.findFirst({
    where: eq(missions.id, missionId),
    columns: { id: true, status: true, scheduleId: true, updatedAt: true },
  });

  if (!mission || mission.status !== 'active') {
    return { action: 'skipped' };
  }

  // 2. Detect heartbeat — skip retrigger later, but still allow completion
  let isHeartbeat = false;
  if (mission.scheduleId) {
    const schedule = await db.query.taskSchedules.findFirst({
      where: eq(taskSchedules.id, mission.scheduleId),
      columns: { taskTemplate: true },
    });
    const ctx = (schedule?.taskTemplate as any)?.context as Record<string, unknown> | undefined;
    isHeartbeat = ctx?.heartbeat === true;
  }

  // 3. Idempotency — atomic debounce via updatedAt timestamp
  const debounceThreshold = new Date(Date.now() - DEBOUNCE_MS);
  const [claimed] = await db
    .update(missions)
    .set({ updatedAt: new Date() })
    .where(
      and(
        eq(missions.id, missionId),
        eq(missions.status, 'active'),
        sql`${missions.updatedAt} < ${debounceThreshold}`
      )
    )
    .returning({ id: missions.id });

  if (!claimed) {
    return { action: 'skipped' };
  }

  // Read the completed planning task to get cycle context
  const planningTask = await db.query.tasks.findFirst({
    where: eq(tasks.id, completedPlanningTaskId),
    columns: { context: true, result: true },
  });

  const taskContext = (planningTask?.context || {}) as Record<string, unknown>;
  const taskResult = (planningTask?.result || {}) as Record<string, unknown>;
  const triggerChainId = (taskContext.triggerChainId as string) || crypto.randomUUID();
  const currentCycle = (taskContext.cycleNumber as number) || 1;

  // 4. Completion detection — intercept missionComplete signal
  const structuredOutput = taskResult.structuredOutput as Record<string, unknown> | undefined;
  if (
    taskResult.missionComplete === true ||
    structuredOutput?.missionComplete === true
  ) {
    // Heartbeat missions skip evaluation — the heartbeat IS the evaluation.
    // Trust it and auto-complete directly.
    if (isHeartbeat) {
      await db
        .update(missions)
        .set({ status: 'completed', updatedAt: new Date() })
        .where(eq(missions.id, missionId));

      if (mission.scheduleId) {
        await db
          .update(taskSchedules)
          .set({ enabled: false, updatedAt: new Date() })
          .where(eq(taskSchedules.id, mission.scheduleId));
      }

      await triggerEvent(
        channels.mission(missionId),
        events.MISSION_LOOP_COMPLETED,
        { missionId, reason: 'heartbeat_complete' }
      );
      return { action: 'completed' };
    }

    // Non-heartbeat: check if all work tasks are terminal → auto-complete
    const allMissionTasks = await db.query.tasks.findMany({
      where: eq(tasks.missionId, missionId),
      columns: { status: true, title: true },
    });
    const workTasks = allMissionTasks.filter(t =>
      !t.title.startsWith('Aggregate results:') &&
      !t.title.startsWith('Evaluate mission completion:') &&
      !t.title.startsWith('Mission:')
    );
    const allDone = workTasks.length > 0 && workTasks.every(t =>
      t.status === 'completed' || t.status === 'failed'
    );
    const hasDeliverables = workTasks.some(t => t.status === 'completed');

    if (allDone && hasDeliverables) {
      await db
        .update(missions)
        .set({ status: 'completed', updatedAt: new Date() })
        .where(eq(missions.id, missionId));

      const m = await db.query.missions.findFirst({
        where: eq(missions.id, missionId),
        columns: { scheduleId: true },
      });
      if (m?.scheduleId) {
        await db
          .update(taskSchedules)
          .set({ enabled: false, updatedAt: new Date() })
          .where(eq(taskSchedules.id, m.scheduleId));
      }

      await triggerEvent(
        channels.mission(missionId),
        events.MISSION_LOOP_COMPLETED,
        { missionId, reason: 'auto_complete_all_done' }
      );
      return { action: 'completed' };
    }

    // Non-trivial state — spawn independent evaluation
    const spawnEval = _spawnEvaluation ?? (await import('@/lib/mission-evaluation')).spawnEvaluationTask;
    const evalTaskId = await spawnEval(missionId, completedPlanningTaskId);

    if (evalTaskId) {
      await triggerEvent(
        channels.mission(missionId),
        events.MISSION_CYCLE_STARTED,
        { missionId, reason: 'evaluation_spawned', evaluationTaskId: evalTaskId }
      );
      return { action: 'evaluation_requested' };
    }

    // Evaluation already pending — skip (don't complete, don't retrigger)
    return { action: 'skipped' };
  }

  // 5. Heartbeat missions don't self-retrigger — cron handles next cycle
  if (isHeartbeat) {
    return { action: 'skipped' };
  }

  // 6. Depth guard — max cycles per trigger chain
  const chainTaskCount = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(tasks)
    .where(
      and(
        eq(tasks.missionId, missionId),
        eq(tasks.mode, 'planning'),
        sql`${tasks.context}->>'triggerChainId' = ${triggerChainId}`
      )
    );

  if ((chainTaskCount[0]?.count || 0) >= MAX_CYCLES_PER_CHAIN) {
    await triggerEvent(
      channels.mission(missionId),
      events.MISSION_LOOP_STALLED,
      { missionId, reason: 'depth_exceeded', maxCycles: MAX_CYCLES_PER_CHAIN, chainId: triggerChainId }
    );
    return { action: 'depth_exceeded' };
  }

  // 6.5. Stuck-planning detection — zero tasks with no completion signal
  // If the organizer reported an empty plan and triageOutcome !== 'conflict',
  // inject corrective feedback into the next cycle
  let stuckPlanningFeedback: string | null = null;
  const planArray = (structuredOutput as any)?.plan as unknown[] | undefined;
  const tasksCreated = Array.isArray(planArray) ? planArray.length : (structuredOutput as any)?.tasksCreated;
  const triageOutcome = (structuredOutput as any)?.triageOutcome;

  if (
    typeof tasksCreated === 'number' &&
    tasksCreated === 0 &&
    triageOutcome !== 'conflict'
  ) {
    const wsState = taskContext.workspaceState as { isCoordination?: boolean; repo?: string | null } | undefined;
    if (wsState?.isCoordination || (wsState && !wsState.repo)) {
      stuckPlanningFeedback =
        'Previous planning cycle produced an empty plan. ' +
        'You are in a meta-workspace (__coordination) or a workspace with no repo. ' +
        'For code missions: create a workspace and repo using manage_workspaces FIRST, then output plan items. ' +
        'Artifacts alone do not advance the mission.';
    } else {
      stuckPlanningFeedback =
        'Previous planning cycle produced an empty plan and did not complete the mission. ' +
        'Output concrete plan items in the plan array. ' +
        'Every planning cycle must either produce plan items or set missionComplete: true.';
    }
  }

  // 7. Stall detection — 2 consecutive COMPLETED cycles with zero non-aggregation children
  //    (Failed tasks are infrastructure issues, not planning stalls — handled separately)
  const recentPlanningTasks = await db.query.tasks.findMany({
    where: and(
      eq(tasks.missionId, missionId),
      eq(tasks.mode, 'planning'),
      eq(tasks.status, 'completed'),
    ),
    orderBy: [desc(tasks.createdAt)],
    limit: 2,
    columns: { id: true },
  });

  let stallCount = 0;
  for (const pt of recentPlanningTasks) {
    const children = await db.query.tasks.findMany({
      where: and(
        eq(tasks.parentTaskId, pt.id),
        sql`${tasks.title} NOT LIKE 'Aggregate results:%'`
      ),
      limit: 1,
      columns: { id: true },
    });

    if (children.length === 0) {
      stallCount++;
    }
  }

  if (stallCount >= 2) {
    await triggerEvent(
      channels.mission(missionId),
      events.MISSION_LOOP_STALLED,
      { missionId, reason: 'stalled', consecutiveEmptyCycles: stallCount }
    );
    return { action: 'stalled' };
  }

  // 8. All guards pass — retrigger
  const nextCycle: CycleContext = {
    cycleNumber: currentCycle + 1,
    triggerChainId,
    triggerSource: 'retrigger',
  };

  const run = _runMission ?? (await import('@/lib/mission-run')).runMission;
  await run(missionId, {
    cycleContext: nextCycle,
    ...(stuckPlanningFeedback ? { stuckPlanningFeedback } : {}),
  });

  await triggerEvent(
    channels.mission(missionId),
    events.MISSION_CYCLE_STARTED,
    { missionId, cycleNumber: nextCycle.cycleNumber, triggerChainId }
  );

  return { action: 'retriggered' };
}

/** Max failed planning tasks within the retry window before giving up */
const MAX_PLANNING_FAILURE_RETRIES = 3;

/** Only count failures within this window (1 hour) — older failures don't block retries */
const FAILURE_WINDOW_MS = 60 * 60 * 1000;

/**
 * Auto-retrigger a mission when one of its planning tasks fails (e.g. worker crash,
 * infrastructure issue). Separate from maybeRetriggerMission which handles completed
 * planning cycles — this handles unexpected failures that should be retried.
 *
 * Guards: mission active, debounce, failure count within 1h window.
 */
export async function retriggerMissionOnFailure(
  missionId: string,
  failedTaskId: string,
): Promise<{ action: LoopAction }> {
  // 1. Mission status check
  const mission = await db.query.missions.findFirst({
    where: eq(missions.id, missionId),
    columns: { id: true, status: true, updatedAt: true },
  });

  if (!mission || mission.status !== 'active') {
    return { action: 'skipped' };
  }

  // 2. Debounce — prevent concurrent retriggers
  const debounceThreshold = new Date(Date.now() - DEBOUNCE_MS);
  const [claimed] = await db
    .update(missions)
    .set({ updatedAt: new Date() })
    .where(
      and(
        eq(missions.id, missionId),
        eq(missions.status, 'active'),
        sql`${missions.updatedAt} < ${debounceThreshold}`
      )
    )
    .returning({ id: missions.id });

  if (!claimed) {
    return { action: 'skipped' };
  }

  // 3. Classify the failure — environmental failures should never be retried
  const failedTask = await db.query.tasks.findFirst({
    where: eq(tasks.id, failedTaskId),
    columns: { result: true },
  });
  const { classifyFailure, extractErrorFromResult } = await import('./failure-classifier');
  const failedResult = (failedTask?.result || {}) as Record<string, unknown>;
  const errorText = extractErrorFromResult(failedResult);
  const failureClass = classifyFailure(errorText);

  if (failureClass === 'environmental') {
    console.warn(`[mission-loop] Mission ${missionId}: environmental failure — not retrying (${errorText.slice(0, 100)})`);
    await triggerEvent(
      channels.mission(missionId),
      events.TASK_RETRY_CAP,
      { missionId, failedTaskId, failureClass, lastError: errorText.slice(0, 200), reason: 'environmental' }
    );
    return { action: 'failure_limit' };
  }

  // 4. Count recent failures — guard against infinite retry loops
  const failureWindowStart = new Date(Date.now() - FAILURE_WINDOW_MS);
  const recentFailures = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(tasks)
    .where(
      and(
        eq(tasks.missionId, missionId),
        eq(tasks.mode, 'planning'),
        eq(tasks.status, 'failed'),
        gt(tasks.createdAt, failureWindowStart),
      )
    );

  const maxRetries = failureClass === 'transient' ? MAX_PLANNING_FAILURE_RETRIES : 2;
  if ((recentFailures[0]?.count || 0) >= maxRetries) {
    console.warn(`[mission-loop] Mission ${missionId}: ${recentFailures[0]?.count} planning failures (${failureClass}) in last hour, stopping auto-retry`);
    await triggerEvent(
      channels.mission(missionId),
      events.TASK_RETRY_CAP,
      { missionId, failedTaskId, failureClass, recentFailures: recentFailures[0]?.count, lastError: errorText.slice(0, 200) }
    );
    return { action: 'failure_limit' };
  }

  // 4. Retrigger — new chain since the failed task's chain is dead
  console.log(`[mission-loop] Auto-retrying mission ${missionId} after planning task ${failedTaskId} failed`);
  const run = await import('@/lib/mission-run').then(m => m.runMission);
  await run(missionId, {
    cycleContext: {
      cycleNumber: 1,
      triggerChainId: crypto.randomUUID(),
      triggerSource: 'auto_retry',
    },
  });

  await triggerEvent(
    channels.mission(missionId),
    events.MISSION_CYCLE_STARTED,
    { missionId, reason: 'failure_auto_retry', failedTaskId }
  );

  return { action: 'failure_retried' };
}
