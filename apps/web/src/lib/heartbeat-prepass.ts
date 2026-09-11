import { db } from '@buildd/core/db';
import { tasks, artifacts, missionNotes } from '@buildd/core/db/schema';
import { eq, sql } from 'drizzle-orm';
import { isDeliverableTask } from '@buildd/core/mission-helpers';
import { isMissionBlocked } from './mission-dependency';
import type { LoopConfig, LoopState } from '@buildd/shared';

/** Non-terminal task statuses — still counted as "remaining work" for a mission. */
const NON_TERMINAL_STATUSES = new Set(['pending', 'assigned', 'in_progress']);

/** Bounded default resume window for a wait with no known resolve time (e.g. a queued reviewer). */
const DEFAULT_WAIT_MS = 30 * 60 * 1000;

export interface WaitClassifiableTask {
  status: string;
  mode: string | null;
  taskClass: 'work' | 'attempt' | 'bookkeeping';
  context: Record<string, unknown> | null;
  startAt: Date | null;
  loopConfig: LoopConfig | null;
  loopState: LoopState | null;
}

export interface MissionWaitResult {
  reason: string;
  waitUntil: Date;
}

/**
 * Classify a single non-terminal task as a known self-resolving wait, or null
 * when it needs real attention (active work, or an unrecognised state — the
 * safe default is to fall through to planning, never to suppress it).
 */
function classifySingleTaskWait(t: WaitClassifiableTask, now: Date): MissionWaitResult | null {
  // Provider budget/rate-limit pause: the worker-terminal path (workers/[id]/route.ts)
  // stamps context.budgetExhausted + startAt = the reset time when it requeues a
  // budget-limited task. Once startAt has passed, the pause has lifted — even if
  // the stale flag is still on context — so this must not report "still waiting" forever.
  if (t.context?.budgetExhausted === true && t.startAt && t.startAt > now) {
    return { reason: 'provider budget/rate-limit pause', waitUntil: t.startAt };
  }

  // Loop task inside its backoff (docs/design/loop-until-verified.md) — covers a
  // CI run in progress via the pr_checks_green exit condition, a command loop
  // still failing, etc. loopState 'running' means a worker is actively iterating
  // right now, which is real progress, not a wait.
  if (t.loopConfig && t.loopState === 'condition_unmet') {
    const waitUntil = t.startAt && t.startAt > now ? t.startAt : new Date(now.getTime() + DEFAULT_WAIT_MS);
    return { reason: 'loop task waiting on its exit condition', waitUntil };
  }

  // Reviewer / CI-retry attempt task queued but not yet claimed by a worker.
  // taskClass='attempt' already means "collapses under its parent" (schema.ts) —
  // these are exactly the review-pass / retry tasks that pile up behind a
  // capacity wall elsewhere in the mission.
  if (t.taskClass === 'attempt' && (t.status === 'pending' || t.status === 'assigned')) {
    return { reason: 'reviewer/retry task queued', waitUntil: new Date(now.getTime() + DEFAULT_WAIT_MS) };
  }

  return null;
}

/**
 * Decide whether EVERY non-terminal task in a mission is sitting on a known
 * self-resolving condition. Returns null the moment any task is not
 * classifiable — this must never suppress planning on uncertainty.
 */
export function classifyMissionWait(
  allTasks: WaitClassifiableTask[],
  now: Date = new Date(),
): MissionWaitResult | null {
  const nonTerminal = allTasks.filter(t => NON_TERMINAL_STATUSES.has(t.status) && t.mode !== 'planning');
  if (nonTerminal.length === 0) return null;

  const reasons = new Set<string>();
  let waitUntil: Date | null = null;

  for (const t of nonTerminal) {
    const classified = classifySingleTaskWait(t, now);
    if (!classified) return null;
    reasons.add(classified.reason);
    if (!waitUntil || classified.waitUntil < waitUntil) waitUntil = classified.waitUntil;
  }

  return { reason: [...reasons].join('; '), waitUntil: waitUntil! };
}

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
  /**
   * All deliverables are terminal — propose completion. Whether the mission
   * actually closes is not decided here: the caller asks
   * `completeMissionIfVerified`, which owns the goal-criteria gate and, crucially,
   * PRODUCES a verdict when none exists. This prepass used to hold its own
   * criteria check (`skip_criteria_blocked`) that could only ever block, never
   * evaluate — so a mission with unevaluated criteria was refused here forever
   * and no path ever produced the verdict that would have released it.
   */
  | { action: 'skip_complete' }
  | { action: 'skip_no_change'; stateKey: string }
  /**
   * Every non-terminal task is sitting on a KNOWN SELF-RESOLVING condition —
   * a provider budget/rate-limit pause, a queued reviewer/CI-retry attempt, or
   * a loop task inside its backoff. Re-invoking the LLM here does nothing but
   * re-propose the same wait/monitor/aggregate/merge coordination steps under
   * new wording every cycle (see classifyMissionWait). The heartbeat instead
   * records when to check back and skips planning entirely — never producing
   * zero tasks by accident, always by this explicit classification.
   */
  | { action: 'skip_waiting'; reason: string; waitUntil: Date };

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
  allTasks: Array<WaitClassifiableTask & { title: string; result: unknown }>;
}> {
  const [allTasks, artifactCountResult, noteCountResult] = await Promise.all([
    db.query.tasks.findMany({
      where: eq(tasks.missionId, missionId),
      columns: {
        status: true, title: true, mode: true, result: true,
        taskClass: true, context: true, startAt: true, loopConfig: true, loopState: true,
      },
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
 * - skip_waiting: every non-terminal task is on a known self-resolving wait
 *   (budget pause, queued reviewer/retry, loop backoff) — check back at waitUntil
 * - skip_complete: all deliverable tasks are terminal — propose completion to the
 *   shared predicate (which may refuse; this prepass does not close missions)
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

  // 3. Every non-terminal task is on a known self-resolving wait → wait, don't plan.
  const wait = classifyMissionWait(allTasks);
  if (wait) {
    return { action: 'skip_waiting', reason: wait.reason, waitUntil: wait.waitUntil };
  }

  // 4. All deliverables terminal → complete the mission in code, no LLM needed
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

  // 5. No state change since last heartbeat → skip (but only if there are deliverables
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
