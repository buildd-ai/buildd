import { db } from '@buildd/core/db';
import { tasks, artifacts, missionNotes } from '@buildd/core/db/schema';
import { eq, sql } from 'drizzle-orm';
import { isDeliverableTask } from '@buildd/core/mission-helpers';
import { isMissionBlocked } from './mission-dependency';

export interface HeartbeatMissionState {
  completedCount: number;
  activeCount: number;
  failedCount: number;
  artifactCount: number;
  prCount: number;
  noteCount: number;
}

export type HeartbeatPrepassDecision =
  | { action: 'invoke_llm'; stateKey: string }
  | { action: 'skip_blocked'; reason: string }
  | { action: 'skip_complete' }
  | { action: 'skip_no_change'; stateKey: string };

/**
 * Deterministic string key encoding all mission state signals.
 * Same state → same key. Used to detect unchanged state between heartbeat runs.
 */
export function computeStateKey(state: HeartbeatMissionState): string {
  return `c${state.completedCount}a${state.activeCount}f${state.failedCount}ar${state.artifactCount}pr${state.prCount}n${state.noteCount}`;
}

/**
 * Query the current mission state needed for heartbeat prepass decisions.
 * Returns both the state counts and the raw task list (for deliverable checks).
 */
async function loadHeartbeatMissionState(missionId: string): Promise<{
  state: HeartbeatMissionState;
  allTasks: Array<{ status: string; title: string; mode: string | null; result: unknown }>;
}> {
  const [allTasks, artifactCountResult, noteCountResult] = await Promise.all([
    db.query.tasks.findMany({
      where: eq(tasks.missionId, missionId),
      columns: { status: true, title: true, mode: true, result: true },
    }),
    db.select({ count: sql<number>`count(*)::int` })
      .from(artifacts)
      .where(eq(artifacts.missionId, missionId)),
    db.select({ count: sql<number>`count(*)::int` })
      .from(missionNotes)
      .where(eq(missionNotes.missionId, missionId)),
  ]);

  const deliverables = allTasks.filter(isDeliverableTask);
  const completedCount = deliverables.filter(t => t.status === 'completed').length;
  const failedCount = deliverables.filter(t => t.status === 'failed').length;
  // Cancelled tasks are excluded: they're "never happened" and shouldn't appear active.
  const activeCount = deliverables.filter(
    t => t.status !== 'completed' && t.status !== 'failed' && t.status !== 'cancelled'
  ).length;

  const prCount = allTasks.filter(t => {
    const result = t.result as Record<string, unknown> | null;
    return result?.prUrl != null;
  }).length;

  return {
    state: {
      completedCount,
      activeCount,
      failedCount,
      artifactCount: artifactCountResult[0]?.count ?? 0,
      prCount,
      noteCount: noteCountResult[0]?.count ?? 0,
    },
    allTasks,
  };
}

/**
 * Evaluate whether a heartbeat mission needs an LLM call this cycle.
 *
 * Returns a deterministic decision without invoking any model:
 * - skip_blocked: upstream dependency not yet met
 * - skip_complete: all deliverable tasks are terminal — mark mission done in code
 * - skip_no_change: mission state identical to last heartbeat (and no open PRs)
 * - invoke_llm: genuine planning decision needed; includes current stateKey to persist
 *
 * If uncertain, falls through to invoke_llm — never suppresses real planning.
 */
export async function evaluateHeartbeatPrepass(input: {
  missionId: string;
  dependsOnMissionId: string | null;
  gateCondition: 'merged' | 'completed';
  dependencyMetAt: Date | null;
  lastHeartbeatStateHash: string | null;
}): Promise<HeartbeatPrepassDecision> {
  // 1. Dependency gate — skip if upstream mission's gate condition isn't met
  const blockStatus = await isMissionBlocked({
    id: input.missionId,
    dependsOnMissionId: input.dependsOnMissionId,
    gateCondition: input.gateCondition,
    dependencyMetAt: input.dependencyMetAt,
  });
  if (blockStatus.blocked) {
    return { action: 'skip_blocked', reason: blockStatus.reason ?? 'upstream dependency unmet' };
  }

  // 2. Load mission state (one parallel DB round-trip)
  const { state, allTasks } = await loadHeartbeatMissionState(input.missionId);

  // 3. All deliverables terminal → complete the mission in code, no LLM needed
  const deliverables = allTasks.filter(isDeliverableTask);
  // Cancelled tasks are terminal (treated as "never happened") — they must not
  // prevent auto-completion when all real work is done.
  const nonCancelledDeliverables = deliverables.filter(t => t.status !== 'cancelled');
  if (
    deliverables.length > 0 &&
    nonCancelledDeliverables.length > 0 &&
    nonCancelledDeliverables.every(t => t.status === 'completed' || t.status === 'failed')
  ) {
    return { action: 'skip_complete' };
  }

  // 4. No state change since last heartbeat → skip (but only if there are deliverables
  //    and no open PRs — PR merge status is external state we can't capture in the hash)
  const stateKey = computeStateKey(state);
  const totalDeliverables = deliverables.length;
  if (
    totalDeliverables > 0 &&
    state.prCount === 0 &&
    input.lastHeartbeatStateHash === stateKey
  ) {
    return { action: 'skip_no_change', stateKey };
  }

  return { action: 'invoke_llm', stateKey };
}
