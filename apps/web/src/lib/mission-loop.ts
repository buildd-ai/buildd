import { db } from '@buildd/core/db';
import { missions, tasks, taskSchedules } from '@buildd/core/db/schema';
import { eq, and, sql, desc } from 'drizzle-orm';
import { triggerEvent, channels, events } from '@/lib/pusher';
import type { CycleContext, RunMissionOptions, RunMissionResult } from '@/lib/mission-run';

/** Max planning cycles within a single trigger chain before stopping */
const MAX_CYCLES_PER_CHAIN = 5;

/** Debounce window (ms) to prevent concurrent re-triggers */
const DEBOUNCE_MS = 10_000;

export type LoopAction = 'retriggered' | 'completed' | 'stalled' | 'depth_exceeded' | 'skipped';

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

export async function maybeRetriggerMission(
  missionId: string,
  completedPlanningTaskId: string,
  /** Injected for testing — defaults to the real runMission */
  _runMission?: RunMissionFn,
): Promise<{ action: LoopAction }> {
  // 1. Mission status check
  const mission = await db.query.missions.findFirst({
    where: eq(missions.id, missionId),
    columns: { id: true, status: true, scheduleId: true, updatedAt: true },
  });

  if (!mission || mission.status !== 'active') {
    return { action: 'skipped' };
  }

  // 2. Heartbeat skip — heartbeat missions stay cron-driven
  if (mission.scheduleId) {
    const schedule = await db.query.taskSchedules.findFirst({
      where: eq(taskSchedules.id, mission.scheduleId),
      columns: { taskTemplate: true },
    });
    const ctx = (schedule?.taskTemplate as any)?.context as Record<string, unknown> | undefined;
    if (ctx?.heartbeat === true) {
      return { action: 'skipped' };
    }
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

  // 4. Completion detection — check if orchestrator signaled mission complete
  const structuredOutput = taskResult.structuredOutput as Record<string, unknown> | undefined;
  if (
    taskResult.missionComplete === true ||
    structuredOutput?.missionComplete === true
  ) {
    await db
      .update(missions)
      .set({ status: 'completed', updatedAt: new Date() })
      .where(eq(missions.id, missionId));

    await triggerEvent(
      channels.mission(missionId),
      events.MISSION_LOOP_COMPLETED,
      { missionId, totalCycles: currentCycle, reason: 'mission_complete' }
    );

    return { action: 'completed' };
  }

  // 5. Depth guard — max cycles per trigger chain
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

  // 6. Stall detection — 2 consecutive cycles with zero non-aggregation children
  const recentPlanningTasks = await db.query.tasks.findMany({
    where: and(
      eq(tasks.missionId, missionId),
      eq(tasks.mode, 'planning'),
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

  // 7. All guards pass — retrigger
  const nextCycle: CycleContext = {
    cycleNumber: currentCycle + 1,
    triggerChainId,
    triggerSource: 'retrigger',
  };

  const run = _runMission ?? (await import('@/lib/mission-run')).runMission;
  await run(missionId, { cycleContext: nextCycle });

  await triggerEvent(
    channels.mission(missionId),
    events.MISSION_CYCLE_STARTED,
    { missionId, cycleNumber: nextCycle.cycleNumber, triggerChainId }
  );

  return { action: 'retriggered' };
}
