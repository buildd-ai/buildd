import { db } from '@buildd/core/db';
import { missions, tasks, taskSchedules, missionNotes, workers } from '@buildd/core/db/schema';
import { eq, and, gte, desc } from 'drizzle-orm';
import { isDeliverableTask } from '@buildd/core/mission-helpers';
import type { CriterionVerdict, GoalCriteriaState, GoalCriterion } from '@buildd/shared';
import { triggerEvent, channels, events } from '@/lib/pusher';
import { checkAndUnblockDependentMissions } from '@/lib/mission-dependency';

/**
 * The one mission-completion predicate.
 *
 * Before this module there were four completion writers with three different
 * predicates: the heartbeat trusted an LLM's `missionComplete=true` with no task
 * or criteria check, dormancy checked criteria but only if a verdict happened to
 * be stored, the heartbeat prepass checked criteria but never produced one, and
 * the release trigger counted pending tasks. A mission could therefore read
 * COMPLETE while the release gate refused to ship it — we were protected only by
 * the accident that the release predicate was the strictest of the four.
 *
 * The rule now, in one sentence: completion REQUESTS a verdict, the verdict GATES
 * completion, and no verdict means not complete. A mission that cannot be verified
 * does not close — it stays `active` and renders as awaiting verification, which
 * keeps its heartbeat and orchestration alive instead of archiving the question
 * away.
 *
 * `canCompleteMission` is therefore not a read-only check: when the work is done
 * and no verdict exists, it PULLS one (see `ensureCriteriaVerdict`). That inverts
 * the old dependency, where the evaluator declined to run while pending work
 * remained — and "is there work left" is exactly what criteria exist to answer.
 *
 * Lives here rather than in `packages/core/mission-helpers.ts` because it reads
 * the database. `mission-helpers.ts` is imported by client components, so a
 * Drizzle import there would ship the pg client to the browser (this has broken
 * `/app` pages before). The pure parts — `recalculateOverall`,
 * `validateGoalCriteria`, `evaluateGoalCriteria` — stay in core; only the
 * DB-touching predicate lives here.
 */

/** Why a completion was refused. `ok` is the only value that permits the write. */
export type CompletionDecisionCode =
  | 'ok'
  | 'mission_not_found'
  | 'mission_not_active'
  | 'no_deliverables'
  | 'pending_deliverables'
  | 'infra_stalled'
  | 'criteria_failed'
  | 'criteria_pending'
  | 'criteria_unverified';

/**
 * Refusals that mean "the goal criteria did not clear". Exported so callers can
 * branch on the class without string-prefix matching — a `startsWith('criteria_')`
 * test in another module silently stops matching the day a code is renamed, and
 * TypeScript cannot see it.
 */
export const CRITERIA_BLOCK_CODES = ['criteria_failed', 'criteria_pending', 'criteria_unverified'] as const;

export function isCriteriaBlockCode(code: CompletionDecisionCode): boolean {
  return (CRITERIA_BLOCK_CODES as readonly string[]).includes(code);
}

/** Which caller asked. Recorded on the decision event for diagnosis. */
export type CompletionPath =
  | 'heartbeat'
  | 'heartbeat_prepass'
  | 'agent_signal'
  | 'dormancy'
  | 'evaluation_task'
  | 'criteria_eval'
  | 'release_trigger';

export interface MissionCompletionDecision {
  ok: boolean;
  code: CompletionDecisionCode;
  /** One line, safe to show a human. Names the blocker, never a hash. */
  reason: string;
  /**
   * Non-terminal rows that are not housekeeping — `work` plus `attempt`, so a
   * pending CI retry counts. The number the heartbeat never took.
   */
  pendingDeliverables: number;
  /** Those same rows broken down by status, e.g. `{ pending: 2 }`. */
  pendingByStatus: Record<string, number>;
  /** Every non-terminal row including housekeeping. The release trigger's extra bar. */
  pendingAllTasks: number;
  /** Terminal deliverables by status, for the completion note. */
  deliverableStatusCounts: Record<string, number>;
  criteriaCount: number;
  /** `'none'` when the mission states no criteria — not the same as a pass. */
  criteriaVerdict: CriterionVerdict | 'none';
  criteriaEvaluatedAt: string | null;
  /** Deliverables that failed on infrastructure, not on their own merits. */
  infraStalledTitles: string[];
}

const TERMINAL_TASK_STATUSES = new Set(['completed', 'failed', 'cancelled']);

/**
 * Housekeeping detection for rows written before `taskClass` existed (the column
 * is NOT NULL DEFAULT 'work', so a legacy planning row reads as work). Mirrors
 * the title prefixes `isDeliverableTask` falls back to.
 */
function isBookkeepingByTitle(task: { title?: string | null; mode?: string | null; kind?: string | null }): boolean {
  if (task.kind === 'coordination') return true;
  if (task.mode === 'planning') return true;
  const title = task.title ?? '';
  return (
    title.startsWith('Aggregate results:') ||
    title.startsWith('Evaluate mission completion:') ||
    title.startsWith('Mission:') ||
    title.startsWith('Close mission') ||
    title.startsWith(VERIFY_TASK_TITLE_PREFIX)
  );
}

/** Title prefix of a goal-criterion verification task. Kept in sync with mission-criteria-verify.ts. */
export const VERIFY_TASK_TITLE_PREFIX = 'Verify goal criterion:';

/** Re-post a given block note at most once per window, so heartbeats don't spam the feed. */
const BLOCK_NOTE_WINDOW_MS = 6 * 60 * 60 * 1000;

export const AWAITING_VERIFICATION_NOTE_TITLE = 'Mission awaiting verification';

/**
 * Decide whether a mission may be marked `completed`.
 *
 * Checks, in order — the first failure is the reported reason:
 *  1. mission exists and is still `active`
 *  2. nothing is still open — any non-terminal `work` or `attempt` row blocks,
 *     including a pending CI retry
 *  3. the mission produced deliverables at all, UNLESS something proposed
 *     completion (a monitoring mission's output is its heartbeat cycles)
 *  4. no deliverable is infra-stalled (failed for infrastructure reasons after
 *     exhausting retries — completing would hide the stall)
 *  5. goal criteria fold to `pass`, evaluating them now if no verdict exists
 *
 * Pending housekeeping rows do NOT block: they are reported in `pendingAllTasks`
 * for the release trigger, which additionally waits for them. That is a timing
 * concern (an aggregation row still running), not a question about whether the
 * goal was met, and it is the one bar this predicate leaves to the caller —
 * always to make it stricter, never looser.
 *
 * @param opts.evaluateCriteria pass `false` for display/read-only callers that
 *        must not spend tokens or dispatch verification tasks.
 */
export async function canCompleteMission(
  missionId: string,
  opts: {
    evaluateCriteria?: boolean;
    path?: CompletionPath;
    acceptCompleted?: boolean;
    /**
     * Something actively claimed the mission is done. Only a proposal may close a
     * mission that produced no deliverable rows of its own — a monitoring mission
     * whose work IS its heartbeat cycles. Dormancy (no proposal) must not, or an
     * empty mission would close itself.
     */
    proposed?: boolean;
  } = {},
): Promise<MissionCompletionDecision> {
  const evaluateCriteria = opts.evaluateCriteria !== false;

  const mission = await db.query.missions.findFirst({
    where: eq(missions.id, missionId),
    columns: {
      id: true,
      title: true,
      status: true,
      goalCriteria: true,
      goalCriteriaState: true,
      autoVerify: true,
    },
  });

  const base = {
    pendingDeliverables: 0,
    pendingByStatus: {} as Record<string, number>,
    pendingAllTasks: 0,
    deliverableStatusCounts: {} as Record<string, number>,
    criteriaCount: 0,
    criteriaVerdict: 'none' as CriterionVerdict | 'none',
    criteriaEvaluatedAt: null as string | null,
    infraStalledTitles: [] as string[],
  };

  if (!mission) {
    return { ...base, ok: false, code: 'mission_not_found', reason: `Mission ${missionId} not found` };
  }
  if (mission.status !== 'active') {
    // An already-completed mission passed this gate when it closed (or a human
    // overrode it deliberately). Callers that only need "was this mission
    // cleared?" — the release trigger — accept that. Callers that want to WRITE
    // completion do not, so the write stays idempotent.
    // `archived` counts too: a mission archived after completing still passed the
    // gate, and a late task finishing in it must not silently skip its release.
    if ((mission.status === 'completed' || mission.status === 'archived') && opts.acceptCompleted) {
      return { ...base, ok: true, code: 'ok', reason: `Mission is already ${mission.status}` };
    }
    return {
      ...base,
      ok: false,
      code: 'mission_not_active',
      reason: `Mission status is ${mission.status}, not active`,
    };
  }

  const criteria = Array.isArray(mission.goalCriteria) ? (mission.goalCriteria as GoalCriterion[]) : [];
  const storedState = (mission.goalCriteriaState ?? null) as GoalCriteriaState | null;
  base.criteriaCount = criteria.length;
  // Report the stored verdict from here on, so an early refusal does not tell a
  // reader the mission had no criteria. `'none'` means "states no criteria" and
  // must never stand in for "has criteria, verdict unknown".
  if (criteria.length > 0) base.criteriaVerdict = storedState?.overall ?? 'NOT_EVALUATED';
  base.criteriaEvaluatedAt = storedState?.evaluatedAt ?? null;

  const allTasks = await db.query.tasks.findMany({
    where: eq(tasks.missionId, missionId),
    columns: {
      id: true, status: true, title: true, mode: true, kind: true,
      taskClass: true, creationSource: true, category: true, result: true,
    },
  });

  base.pendingAllTasks = allTasks.filter(t => !TERMINAL_TASK_STATUSES.has(t.status)).length;

  const deliverables = allTasks.filter(isDeliverableTask);

  // What blocks: any non-terminal row that is not housekeeping — i.e. `work` AND
  // `attempt`. A pending `[CI Retry #1]` is taskClass 'attempt', so it is not a
  // deliverable; counting only deliverables would let a mission close with CI red
  // and a retry in flight. The task that prompted this change named exactly that
  // ("assessed ALL pending work including attempt/CI-retry tasks"), and the old
  // title-prefix filter on the signalled path did catch it.
  const pending = allTasks.filter(
    t => t.taskClass !== 'bookkeeping' && !isBookkeepingByTitle(t) && !TERMINAL_TASK_STATUSES.has(t.status),
  );
  base.pendingDeliverables = pending.length;
  for (const t of pending) base.pendingByStatus[t.status] = (base.pendingByStatus[t.status] ?? 0) + 1;
  for (const t of deliverables) {
    if (TERMINAL_TASK_STATUSES.has(t.status)) {
      base.deliverableStatusCounts[t.status] = (base.deliverableStatusCounts[t.status] ?? 0) + 1;
    }
  }

  if (pending.length > 0) {
    const breakdown = Object.entries(base.pendingByStatus).map(([s, n]) => `${n} ${s}`).join(', ');
    return {
      ...base,
      ok: false,
      code: 'pending_deliverables',
      reason: `${pending.length} task(s) still open (${breakdown})`,
    };
  }

  if (deliverables.length === 0 && !opts.proposed) {
    // A mission of housekeeping rows has not finished; it has not started — so
    // dormancy must not close it. (All-cancelled deliverables DO allow
    // completion: the work was deliberately called off, which is a decision, not
    // an absence.)
    //
    // A PROPOSAL is different: a monitoring mission's whole output is its
    // heartbeat cycles, which are bookkeeping rows, so it has no deliverables by
    // construction. Refusing those unconditionally left them unable to close
    // ever, which is how removing the heartbeat's fast path could have stranded
    // every watcher mission on the platform.
    return {
      ...base,
      ok: false,
      code: 'no_deliverables',
      reason: 'Mission has no deliverable tasks and nothing proposed completion',
    };
  }

  const infraStalled = deliverables.filter(
    t => t.status === 'failed' && (t.result as Record<string, unknown> | null)?.errorType === 'infra_stalled',
  );
  if (infraStalled.length > 0) {
    base.infraStalledTitles = infraStalled.map(t => t.title);
    return {
      ...base,
      ok: false,
      code: 'infra_stalled',
      reason:
        `${infraStalled.length} deliverable task(s) failed on infrastructure and need manual intervention: ` +
        base.infraStalledTitles.map(t => `"${t}"`).join(', '),
    };
  }

  if (criteria.length === 0) {
    return { ...base, ok: true, code: 'ok', reason: 'All deliverables terminal; mission states no goal criteria' };
  }

  // The work is done and criteria exist — this is the moment a verdict is owed.
  let state = (mission.goalCriteriaState ?? null) as GoalCriteriaState | null;
  if (evaluateCriteria) {
    const { ensureCriteriaVerdict } = await import('@/lib/mission-criteria-eval');
    state = await ensureCriteriaVerdict(missionId, { trigger: opts.path ?? 'dormancy' });
  }

  base.criteriaVerdict = state?.overall ?? 'NOT_EVALUATED';
  base.criteriaEvaluatedAt = state?.evaluatedAt ?? null;

  if (state?.overall === 'pass') {
    return { ...base, ok: true, code: 'ok', reason: `All ${criteria.length} goal criteria pass` };
  }

  const nonPass = (state?.criteria ?? []).filter(c => c.verdict !== 'pass');
  const detail = nonPass.length > 0
    ? nonPass.map(c => `[${c.verdict}] ${c.label ?? c.type}${c.evidence ? ': ' + c.evidence : ''}`).join('; ')
    : 'no criteria state stored';

  if (state?.overall === 'fail') {
    return { ...base, ok: false, code: 'criteria_failed', reason: `Goal criteria failed — ${detail}` };
  }
  if (nonPass.some(c => c.verdict === 'PENDING')) {
    return { ...base, ok: false, code: 'criteria_pending', reason: `Goal criteria verification in flight — ${detail}` };
  }
  return {
    ...base,
    ok: false,
    code: 'criteria_unverified',
    reason: `Goal criteria not verified (overall: ${state?.overall ?? 'not evaluated'}) — ${detail}`,
  };
}

export interface CompleteMissionResult {
  completed: boolean;
  decision: MissionCompletionDecision;
}

/**
 * The one writer of `missions.status = 'completed'` for automated paths.
 *
 * Every caller — heartbeat, heartbeat prepass, dormancy, the independent
 * evaluation task, and the criteria evaluator — routes through here, so an
 * agent's `missionComplete=true` is a PROPOSAL this function may refuse.
 * A refusal is not a silent no-op: it emits the decision event with the
 * predicate inputs and posts (at most once per window) a feed note naming the
 * blocker. M2 closed with two deliverables pending and four criteria reading
 * "not yet evaluated" precisely because nothing was required to say either.
 *
 * Explicit human transitions (dashboard, MCP `manage_missions` status=completed)
 * deliberately do NOT come through here — a person may always override.
 */
export async function completeMissionIfVerified(
  missionId: string,
  opts: {
    path: CompletionPath;
    /** What claimed the mission was done, e.g. the planning task id. */
    predicate?: string;
    /** Reuse an already-computed decision instead of re-querying. */
    decision?: MissionCompletionDecision;
    /** Skip criteria evaluation (callers that already produced a verdict). */
    evaluateCriteria?: boolean;
    /**
     * True when something actively claimed the mission was done (a heartbeat's
     * `missionComplete=true`, an evaluation task's verdict). A refused proposal
     * always gets a feed note — an unanswered claim of completion is the exact
     * silence this module exists to remove. Routine polling (`false`) does not
     * note a still-working mission; that would be one warning per task.
     */
    proposed?: boolean;
  },
): Promise<CompleteMissionResult> {
  const decision = opts.decision
    ?? await canCompleteMission(missionId, {
      path: opts.path,
      evaluateCriteria: opts.evaluateCriteria,
      proposed: opts.proposed,
    });

  // Emitted for real decisions only. `mission_not_found` / `mission_not_active`
  // mean nothing was decided, and this runs on every terminal task in every
  // mission — Pusher messages are metered.
  const worthAnEvent = decision.code !== 'mission_not_found' && decision.code !== 'mission_not_active';
  if (worthAnEvent) await triggerEvent(channels.mission(missionId), events.MISSION_COMPLETION_DECISION, {
    missionId,
    path: opts.path,
    allowed: decision.ok,
    code: decision.code,
    reason: decision.reason,
    pendingDeliverables: decision.pendingDeliverables,
    pendingByStatus: decision.pendingByStatus,
    pendingAllTasks: decision.pendingAllTasks,
    deliverableStatusCounts: decision.deliverableStatusCounts,
    criteriaCount: decision.criteriaCount,
    criteriaVerdict: decision.criteriaVerdict,
    criteriaEvaluatedAt: decision.criteriaEvaluatedAt,
    ...(opts.predicate ? { predicate: opts.predicate } : {}),
  }).catch(e => console.error(`[mission-completion] decision event failed for ${missionId}:`, e));

  console.log(
    `[mission-completion] ${missionId} via ${opts.path}: ${decision.ok ? 'COMPLETE' : `BLOCKED (${decision.code})`}` +
    ` — pendingDeliverables=${decision.pendingDeliverables} pendingAll=${decision.pendingAllTasks}` +
    ` criteria=${decision.criteriaVerdict} :: ${decision.reason}`
  );

  if (!decision.ok) {
    const worthANote =
      decision.code !== 'mission_not_found' &&
      decision.code !== 'mission_not_active' &&
      (opts.proposed === true || decision.code.startsWith('criteria_') || decision.code === 'infra_stalled');
    if (worthANote) await postAwaitingVerificationNote(missionId, opts.path, decision);
    return { completed: false, decision };
  }

  // Atomic active → completed. Concurrent callers race here; exactly one wins,
  // and only the winner disables the schedule and announces completion.
  const [claimed] = await db
    .update(missions)
    .set({ status: 'completed', updatedAt: new Date() })
    .where(and(eq(missions.id, missionId), eq(missions.status, 'active')))
    .returning({ id: missions.id, scheduleId: missions.scheduleId });

  if (!claimed) {
    return {
      completed: false,
      decision: {
        ...decision,
        ok: false,
        code: 'mission_not_active',
        reason: 'Mission left active state concurrently',
      },
    };
  }

  if (claimed.scheduleId) {
    await db
      .update(taskSchedules)
      .set({ enabled: false, updatedAt: new Date() })
      .where(eq(taskSchedules.id, claimed.scheduleId));
  }

  const statusSummary = Object.entries(decision.deliverableStatusCounts).map(([s, n]) => `${s}: ${n}`).join(', ');
  await db.insert(missionNotes).values({
    missionId,
    authorType: 'system',
    type: 'update',
    title: 'Mission completed',
    body:
      `Completed via ${opts.path}.\n\n` +
      `Predicate: ${decision.reason}\n` +
      `Deliverables: ${statusSummary || 'none'}\n` +
      `Goal criteria: ${decision.criteriaVerdict}` +
      (decision.criteriaEvaluatedAt ? ` (evaluated ${decision.criteriaEvaluatedAt})` : '') +
      (opts.predicate ? `\nSignal: ${opts.predicate}` : ''),
    status: 'open',
  } as any).catch(e => console.error(`[mission-completion] completion note failed for ${missionId}:`, e));

  await checkAndUnblockDependentMissions(missionId, 'completed').catch(e =>
    console.error(`[mission-completion] unblock failed for ${missionId}:`, e)
  );

  await triggerEvent(channels.mission(missionId), events.MISSION_LOOP_COMPLETED, {
    missionId,
    reason: `${opts.path}_complete`,
    taskStatusCounts: decision.deliverableStatusCounts,
    criteriaVerdict: decision.criteriaVerdict,
  }).catch(e => console.error(`[mission-completion] completed event failed for ${missionId}:`, e));

  // A mission clearing the gate is the moment an `on_mission_complete` release
  // becomes due. Before this, the release could only ever be attempted from a
  // worker-completion PATCH — so a verdict that turned green anywhere else (a
  // heartbeat evaluation, a merge webhook flipping all_prs_merged, the on-demand
  // evaluate route) left the mission reading COMPLETE with nothing deployed and
  // no error anywhere. Fire-and-forget: a release failure must not un-complete
  // the mission.
  void attemptMissionRelease(missionId).catch(e =>
    console.error(`[mission-completion] release attempt failed for ${missionId}:`, e)
  );

  return { completed: true, decision };
}

/**
 * Ask the release trigger to reconsider now that the mission has closed.
 *
 * `fireMissionReleaseIfComplete` needs a task + worker to resolve the source
 * branch for `branch_merge` strategies, so pick the mission's most recently
 * completed deliverable that actually has a worker. Imported dynamically:
 * mission-release imports `canCompleteMission` from this module, and a static
 * import back would be a cycle.
 */
async function attemptMissionRelease(missionId: string): Promise<void> {
  const rows = await db
    .select({ taskId: tasks.id, workspaceId: tasks.workspaceId })
    .from(tasks)
    .where(and(eq(tasks.missionId, missionId), eq(tasks.status, 'completed')))
    .orderBy(desc(tasks.updatedAt))
    .limit(10);

  const candidate = rows.find(r => r.workspaceId);
  if (!candidate?.workspaceId) return;

  const worker = await db.query.workers.findFirst({
    where: eq(workers.taskId, candidate.taskId),
    columns: { id: true },
    orderBy: (w, { desc: d }) => [d(w.startedAt)],
  });
  if (!worker) return;

  const { fireMissionReleaseIfComplete } = await import('@/lib/mission-release');
  await fireMissionReleaseIfComplete(candidate.workspaceId, missionId, candidate.taskId, worker.id);
}

/**
 * Post the "why this mission is still open" note, at most once per
 * BLOCK_NOTE_WINDOW_MS per distinct reason. Without the window a 15-minute
 * heartbeat would write the same warning 96 times a day and the feed would stop
 * being readable.
 */
async function postAwaitingVerificationNote(
  missionId: string,
  path: CompletionPath,
  decision: MissionCompletionDecision,
): Promise<void> {
  // First line is a stable machine-readable key; the prose below it carries the
  // volatile detail (counts, task ids, evidence). Deduping on the whole body was
  // useless: a verification task id or a pending count changes every round, so a
  // 15-minute heartbeat produced a fresh "duplicate" note each time.
  const key = `[${decision.code}]`;
  const body =
    `${key} ${decision.reason}\n\n` +
    `Proposed by: ${path}. The mission stays active and orchestrated — it is awaiting verification, ` +
    `not complete. Completion resumes automatically once the blocker clears.`;

  try {
    const since = new Date(Date.now() - BLOCK_NOTE_WINDOW_MS);
    const recent = await db.query.missionNotes.findMany({
      where: and(
        eq(missionNotes.missionId, missionId),
        eq(missionNotes.title, AWAITING_VERIFICATION_NOTE_TITLE),
        gte(missionNotes.createdAt, since),
      ),
      columns: { body: true },
      limit: 20,
    });
    if (recent.some(n => (n.body ?? '').startsWith(key))) return;

    await db.insert(missionNotes).values({
      missionId,
      authorType: 'system',
      type: 'warning',
      title: AWAITING_VERIFICATION_NOTE_TITLE,
      body,
      status: 'open',
    } as any);
  } catch (e) {
    console.error(`[mission-completion] awaiting-verification note failed for ${missionId}:`, e);
  }
}
