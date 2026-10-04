/**
 * `explain` — the deterministic read behind the MCP action of the same name.
 *
 * One question, four scopes (task / mission / workspace / PR), one response
 * shape. It answers "what state is this in, what is it waiting on, and what is
 * the evidence" by reading authoritative rows and running the derivations that
 * already own each axis. There is no model call anywhere in this module, by
 * design: the caller narrates, `explain` supplies facts with provenance.
 *
 * Two consequences of "deterministic" that are easy to get wrong and are
 * enforced here:
 *
 * - `canCompleteMission` is called with `evaluateCriteria: false`. The default
 *   PULLS a verdict when none exists, which dispatches verification tasks and
 *   spends tokens — correct for the completion path, wrong for a read.
 * - The conflicted-PR chain never shells out to a merge attempt. Both touch
 *   sets are already stored (`workers.observedTouches`, `tasks.pathManifest`).
 *
 * State comes from `deriveMissionStateView`, which owns the precedence between
 * the five underlying derivations. This module does not decide what a state is;
 * it only supplies the accessor's inputs and turns its answer into evidence.
 */
import { BACKEND_ROUTING_KEY, describeBackendRouting } from '@buildd/core/backend-policy';
import { OPEN_TASK_STATUSES as SHARED_OPEN_TASK_STATUSES, LIVE_WORKER_STATUSES as SHARED_LIVE_WORKER_STATUSES, type TaskEvidence, type TaskMismatch } from '@buildd/shared';
import { collectLineage } from '@/lib/attempt-lineage';
import { evidenceHint } from '@/lib/task-evidence';
import { loadInlineEvidence, type InlineEvidenceObject } from '@/lib/evidence-inline';
import type { EvidenceActor } from '@/lib/evidence-audit';
import { db } from '@buildd/core/db';
import { missions, tasks, workers, gateEvents } from '@buildd/core/db/schema';
import { and, desc, eq, gt, inArray, isNotNull, ne } from 'drizzle-orm';
import { deriveCriteriaGatePresentation, attachAttempts, isDeliverableTask } from '@buildd/core/mission-helpers';
import { deriveTaskHealthSignal, foreignDependencyIds, unmetDependencyIds, unmetDependencyPrs, type DependencyRow } from '@/lib/mission-helpers';
import { continueOnRunnerBlockedReason, deriveLocalStrand } from '@/lib/local-strand';
import { loadDependencyRows } from '@/lib/dependency-rows';
import { derivePrDisplayState } from '@/lib/pr-presentation';
import { canCompleteMission } from '@/lib/mission-completion';
import { classifyMissionWait, type WaitClassifiableTask } from '@/lib/heartbeat-prepass';
import { evaluateMissionWorkState } from '@/lib/mission-pr';
import { deriveMissionStateView, type MissionStateInput, type MissionStateView } from '@/lib/mission-state-view';
import { computeSupersededFailedTasks } from '@/lib/mission-task-superseded';
import { loadMissionClaimDeferrals } from '@/lib/mission-claim-deferrals';
import { deriveMissionIntegrationPr } from '@/lib/mission-integration-pr';
import { missionCardProgress, ownerUnmergedPrs, type MissionCardTaskRow } from '@/lib/mission-card-view';
import { REPO_WIDE_SENTINEL } from '@buildd/core/path-overlap';
import { deriveCiRedChains } from './ci-red-chain';
import {
  buildStateBecause,
  buildConflictBecause,
  type BaseSideMerge,
  type StateBecauseExtras,
  type ConflictSubject,
  type TouchSource,
} from '@/lib/explain-because';
import {
  orderChain,
  rankGatedSubjects,
  type ExplainAnswer,
  type ExplainResult,
  type HistoryNode,
  type GateHistoryEntry,
} from '@/lib/explain-types';

/** How many recent gate_events rows a task's `explain` answer carries. */
const GATE_HISTORY_LIMIT = 10;

/**
 * Recent gate_events rows for a task — deferrals, rejections, warnings, and
 * strandings, newest first. This is the durable half of the claim loop's
 * per-poll `deferrals` counters (which die with the response object) made
 * readable without SQL.
 */
async function loadGateHistory(taskId: string): Promise<GateHistoryEntry[]> {
  const rows = await db.query.gateEvents.findMany({
    where: eq(gateEvents.taskId, taskId),
    orderBy: [desc(gateEvents.occurredAt)],
    limit: GATE_HISTORY_LIMIT,
    columns: { occurredAt: true, gate: true, outcome: true, reason: true, detail: true },
  });
  return rows.map(r => {
    const detail = r.detail as Record<string, unknown> | null;
    return {
      occurredAt: r.occurredAt.toISOString(),
      gate: r.gate,
      outcome: r.outcome as GateHistoryEntry['outcome'],
      reason: r.reason,
      consecutiveDeferrals: typeof detail?.consecutiveDeferrals === 'number' ? detail.consecutiveDeferrals : null,
      firstDeferredAt: typeof detail?.firstDeferredAt === 'string' ? detail.firstDeferredAt : null,
    };
  });
}

/** Cap on how many gated subjects a workspace answer returns. */
const WORKSPACE_SUBJECT_LIMIT = 12;
/** Cap on base-side merges examined for a conflicted PR. */
const BASE_SIDE_LIMIT = 40;
/**
 * Cap on concurrent `explainMission`/`explainTask` calls during workspace
 * fan-out. Each call is several DB round trips, so unbounded `Promise.all`
 * over up to 200 missions/tasks would spike Neon HTTP-driver fan-out; a
 * sequential loop, the other extreme, made a single busy workspace's
 * `GET /api/explain` call slow. This bounds both.
 */
const WORKSPACE_FANOUT_CONCURRENCY = 8;

/**
 * Runs `fn` over `items` with at most `limit` in flight at once. Results are
 * returned in input order regardless of completion order.
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (let i = next++; i < items.length; i = next++) {
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** Cap on active missions scanned per workspace answer — mirrors the orphan-tasks cap below. */
const MISSION_SCAN_LIMIT = 200;

// ─── Shared loading ───────────────────────────────────────────────────────────

type LoadedTask = {
  id: string;
  title: string;
  status: string;
  mode: string | null;
  kind: string | null;
  taskClass: string;
  parentTaskId: string | null;
  creationSource: string | null;
  category: string | null;
  subjectPrNumber: number | null;
  pathManifest: string[] | null;
  context: Record<string, unknown> | null;
  startAt: Date | null;
  loopConfig: unknown;
  loopState: unknown;
  result: unknown;
  createdAt: Date | null;
  updatedAt?: Date | null;
  dependsOn?: string[] | null;
  workers: Array<{
    id: string;
    status: string;
    prNumber: number | null;
    prUrl: string | null;
    branch: string | null;
    prBaseRef: string | null;
    prLifecycleStatus: string | null;
    mergedAt: Date | null;
    observedTouches: string[] | null;
    error: string | null;
    startedAt: Date | null;
    supersededByPrNumber: number | null;
    supersededByPrUrl: string | null;
    supersededReason: string | null;
    abandonedAt?: Date | null;
    abandonedReason?: string | null;
    supersessionScan?: import('@buildd/core/pr-shipped').SupersessionScan | null;
  }>;
};

const TASK_COLUMNS = {
  id: true, title: true, status: true, mode: true, kind: true, taskClass: true,
  parentTaskId: true, creationSource: true, category: true, subjectPrNumber: true,
  pathManifest: true, context: true, startAt: true, loopConfig: true, loopState: true,
  result: true, createdAt: true, updatedAt: true, dependsOn: true,
} as const;

/**
 * Newest worker first — the same "latest worker per task" rule the PR
 * predicates use, so `workers[0]` means the same thing everywhere.
 */
const WORKER_WITH = {
  columns: {
    id: true, status: true, prNumber: true, prUrl: true, branch: true,
    prBaseRef: true, prLifecycleStatus: true, mergedAt: true,
    observedTouches: true, error: true, startedAt: true,
    // The session heartbeat `deriveLocalStrand` reads, and the PR grace window.
    updatedAt: true, completedAt: true,
    supersededByPrNumber: true, supersededByPrUrl: true, supersededReason: true,
    abandonedAt: true, abandonedReason: true, supersessionScan: true,
  },
  orderBy: [desc(workers.startedAt)],
};

const LIVE_WORKER_STATUSES = new Set<string>(SHARED_LIVE_WORKER_STATUSES);
const OPEN_TASK_STATUSES = new Set<string>(SHARED_OPEN_TASK_STATUSES);

/** True when a worker in a live status is on this row — the per-task half of `activeAgents`. */
function hasLiveWorker(t: { workers?: Array<{ status: string }> | null }): boolean {
  return (t.workers ?? []).some(w => LIVE_WORKER_STATUSES.has(w.status));
}

/** The canonical "is a fix attempt open on this task" descriptor — see mission-state-view.ts rule 6½. */
export interface OpenAttemptInfo {
  taskId: string;
  title: string;
  status: string;
  iteration: number | null;
  maxIterations: number | null;
  claimed: boolean;
}

/**
 * The newest OPEN fix attempt (builder-after-review, CI retry) among a task's
 * children. While one is open the PR is about to change, so it — not a merge —
 * is what the task is waiting on. The single definition every surface that
 * needs this fact reads: `viewForTask` (this module), and any caller outside
 * explain.ts via {@link loadOpenAttempt}. Do not re-derive this predicate
 * elsewhere — see the task-detail PR card and the Home action queue for two
 * callers that used to each have their own partial version of it.
 */
function deriveOpenAttempt(attempts: LoadedTask[]): OpenAttemptInfo | null {
  const openAttemptRow = attempts
    .filter(a => a.taskClass === 'attempt' && OPEN_TASK_STATUSES.has(a.status))
    .sort((a, b) => new Date(b.createdAt ?? 0).getTime() - new Date(a.createdAt ?? 0).getTime())[0];
  if (!openAttemptRow) return null;
  const attemptCtx = (openAttemptRow.context ?? {}) as { iteration?: unknown; maxIterations?: unknown };
  return {
    taskId: openAttemptRow.id,
    title: openAttemptRow.title,
    status: openAttemptRow.status,
    iteration: typeof attemptCtx.iteration === 'number' ? attemptCtx.iteration : null,
    maxIterations: typeof attemptCtx.maxIterations === 'number' ? attemptCtx.maxIterations : null,
    claimed:
      openAttemptRow.status !== 'pending' ||
      (openAttemptRow.workers ?? []).some(w => LIVE_WORKER_STATUSES.has(w.status)),
  };
}

/**
 * Convenience wrapper for a caller that only wants the open-attempt fact, not
 * a full `explainTask` answer (history, gate history, evidence objects, …).
 * One extra query — children of `taskId` with their latest worker — reading
 * the exact same columns and the exact same predicate `viewForTask` uses.
 */
export async function loadOpenAttempt(taskId: string): Promise<OpenAttemptInfo | null> {
  const attempts = (await db.query.tasks.findMany({
    where: eq(tasks.parentTaskId, taskId),
    columns: TASK_COLUMNS,
    with: { workers: WORKER_WITH },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  })) as any as LoadedTask[];
  return deriveOpenAttempt(attempts);
}

function iso(d: Date | string | null | undefined): string | null {
  if (!d) return null;
  return d instanceof Date ? d.toISOString() : new Date(d).toISOString();
}

/** A history node's PR state: `derivePrDisplayState`, projected onto `HistoryNode['prState']`. */
export function historyPrStateOf(
  w: Pick<LoadedTask['workers'][number], 'prNumber' | 'prLifecycleStatus' | 'mergedAt'> | undefined,
): HistoryNode['prState'] {
  if (!w?.prNumber) return 'none';
  const state = derivePrDisplayState(w.prLifecycleStatus, w.mergedAt);
  switch (state) {
    case 'merged': case 'closed': case 'conflict': case 'ci_failed': return state;
    case 'unresolvable': return 'closed';
    default: return 'open';
  }
}

/**
 * Attempts collapsed under their parent via `parentTaskId` + `taskClass`.
 * Nesting is read through `attachAttempts` (PR #1674) — not re-derived here.
 */
function buildHistory(loaded: LoadedTask[]): HistoryNode[] {
  const attemptsByParent = attachAttempts(loaded);
  const ids = new Set(loaded.map(t => t.id));
  const byCreated = (a: LoadedTask, b: LoadedTask) =>
    (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0);

  const toNode = (t: LoadedTask, path: Set<string>): HistoryNode => {
    const w = t.workers?.[0];
    const result = (t.result ?? null) as { evidence?: TaskEvidence; mismatch?: TaskMismatch[] } | null;
    const hint = evidenceHint(result?.evidence);
    const nextPath = new Set(path).add(t.id);
    return {
      taskId: t.id,
      title: t.title,
      status: t.status,
      taskClass: t.taskClass,
      prNumber: w?.prNumber ?? null,
      prState: historyPrStateOf(w),
      createdAt: iso(t.createdAt),
      ...(hint ? { evidence: hint } : {}),
      ...(Array.isArray(result?.mismatch) && result.mismatch.length > 0 ? { mismatch: result.mismatch } : {}),
      // Attempts nest through attempts (a CI fix's own CI fix), not one level.
      attempts: (attemptsByParent.get(t.id) ?? [])
        .filter(a => !nextPath.has(a.id))
        .sort(byCreated)
        .map(a => toNode(a, nextPath)),
    };
  };

  // A root is any task that is not an attempt of another task in view. An
  // attempt whose parent is outside the loaded set still reads as a root, so
  // the history of an attempt subject is never empty.
  const parentInView = (t: LoadedTask) => t.parentTaskId != null && ids.has(t.parentTaskId);
  return loaded
    .filter(t => t.taskClass !== 'attempt' || !parentInView(t))
    .sort(byCreated)
    .map(t => toNode(t, new Set()));
}

/** `workers.observedTouches` ∪ `tasks.pathManifest`, with how it was determined. */
function touchSetOf(
  task: { pathManifest: string[] | null } | null,
  worker: { observedTouches: string[] | null } | null,
): { touches: string[]; touchSource: TouchSource } {
  const observed = (worker?.observedTouches ?? []).filter(Boolean);
  const declared = (task?.pathManifest ?? []).filter(p => p && p !== REPO_WIDE_SENTINEL);
  const touches = [...new Set([...observed, ...declared])];

  if (touches.length === 0) return { touches, touchSource: 'undeclared' };
  if (observed.length > 0 && declared.length > 0) {
    return { touches, touchSource: 'observedTouches+pathManifest' };
  }
  return { touches, touchSource: observed.length > 0 ? 'observedTouches' : 'pathManifest' };
}

// ─── Mission scope ────────────────────────────────────────────────────────────

/**
 * Assemble the accessor's inputs for a mission by running each derivation
 * exactly once, then hand them to `deriveMissionStateView`.
 */
async function viewForMission(missionId: string): Promise<{
  view: MissionStateView;
  mission: Record<string, unknown>;
  loaded: LoadedTask[];
  answerExtras: StateBecauseExtras;
} | null> {
  const mission = await db.query.missions.findFirst({
    where: eq(missions.id, missionId),
    with: { schedule: true },
  });
  if (!mission) return null;

  const loaded = (await db.query.tasks.findMany({
    where: eq(tasks.missionId, missionId),
    columns: TASK_COLUMNS,
    with: { workers: WORKER_WITH },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  })) as any as LoadedTask[];

  const m = mission as unknown as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const schedule = m.schedule as { lastDeferralReason?: string | null; nextRunAt?: Date | null } | null;
  // Same read the mission detail page does: a heartbeat that is deliberately
  // holding records its resume time on the schedule row.
  const heartbeatWaitingUntil =
    schedule?.lastDeferralReason === 'heartbeat_waiting' ? schedule?.nextRunAt ?? null : null;

  // Dependencies outside this mission are judged from their own rows, never
  // guessed (unknown is not unmet): one query by id list.
  const foreignDeps = await loadDependencyRows(foreignDependencyIds(loaded));
  const deliverables = loaded.filter(isDeliverableTask);
  const failedDeliverables = deliverables.filter(t => t.status === 'failed');
  const supersededMap = await computeSupersededFailedTasks(
    missionId,
    (m.workspaceId as string | null) ?? null,
    failedDeliverables.map(t => ({
      id: t.id,
      title: t.title,
      subjectPrNumber: t.subjectPrNumber,
      createdAt: t.createdAt,
    })),
  );

  const health = deriveTaskHealthSignal(
    { ...m, heartbeatWaitingUntil },
    loaded.map(t => ({ ...t, superseded: supersededMap.has(t.id) })),
    { dependencies: foreignDeps },
  );

  // The card's n/N (`missionCardProgress`): rows folded (D1), cancelled out of
  // N, a completed task with an open PR not done. One definition, so the
  // criteria gate below presents the same on the card and on this page.
  const counted = missionCardProgress(loaded as unknown as MissionCardTaskRow[]);
  const progress = counted.total > 0 ? counted.progress : undefined;

  const criteria = Array.isArray(m.goalCriteria) ? (m.goalCriteria as unknown[]) : [];
  const criteriaState = (m.goalCriteriaState ?? null) as
    | { overall?: string; criteria?: Array<{ verdict: string; label?: string; type?: string; evidence?: string }> }
    | null;
  const criteriaItems = criteriaState?.criteria ?? [];
  const criteriaGate = ['completed', 'cancelled', 'archived'].includes(String(m.status))
    ? null
    : deriveCriteriaGatePresentation({
        criteriaCount: criteria.length,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        overall: (criteriaState?.overall as any) ?? null,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        items: criteriaItems as any,
        completionAttempted: progress !== undefined && progress >= 100,
      });

  // evaluateCriteria: false — a read must never dispatch a verification task or
  // spend a token to answer "what is this waiting on".
  const completion = await canCompleteMission(missionId, { evaluateCriteria: false });

  const wait = classifyMissionWait(loaded as unknown as WaitClassifiableTask[]);

  // Only meaningful for a mission on an integration branch; for every other
  // mission it would answer a question nobody asked and cost a query.
  const workState = m.integrationBranchEnabled && m.workingBranch
    ? await evaluateMissionWorkState(missionId)
    : null;

  // The claim loop's durable refusal ledger. Read unconditionally: the whole
  // point is that a task nothing has been allowed to start looks, from every
  // other source, exactly like a task nothing is wrong with.
  //
  // Filtered to tasks still `pending`: `gate_events` never gets a "cleared"
  // row when a task finally dispatches (see `DEFERRAL_FRESHNESS_MS`'s own
  // note), so a task that was deferred and then claimed and completed within
  // the freshness window still reads as stuck by age alone. The row set
  // already loaded above is the current answer to "did it leave pending" and
  // costs nothing extra to consult.
  const pendingTaskIds = new Set(loaded.filter(t => t.status === 'pending').map(t => t.id));
  const deferrals = (await loadMissionClaimDeferrals(missionId)).filter(d => pendingTaskIds.has(d.taskId));

  // `canCompleteMission` knows the mission PR has not merged; only the task
  // rows know where it is. Supplying it turns "the mission PR has not merged"
  // into an affordance with a destination.
  const integrationPr = deriveMissionIntegrationPr({
    mission: m as { workingBranch?: string | null; integrationBranchEnabled?: boolean | null },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tasks: loaded as any,
  });

  const activeAgents = loaded.flatMap(t => t.workers ?? []).filter(w => LIVE_WORKER_STATUSES.has(w.status)).length;
  const openTasks = deliverables.filter(t => OPEN_TASK_STATUSES.has(t.status));
  // A pending row waiting on an unmet dependency cannot be the blocker; the
  // accessor cites the dependency instead (same rule as the claim gate).
  const loadedById = new Map<string, DependencyRow>(foreignDeps);
  for (const t of loaded) loadedById.set(t.id, t);
  const waitingOnOf = (t: LoadedTask) => (t.status === 'pending' ? unmetDependencyIds(t, loadedById) : []);
  // The card's own reading of the same rows (`ownerUnmergedPrs`,
  // `deriveLocalStrand`), so a card and this answer cannot disagree on
  // "waiting on you to merge" or "stranded".
  const now = Date.now();
  const strand = deriveLocalStrand({
    executor: m.executor ?? null,
    isHeld: m.isHeld === true,
    status: String(m.status),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tasks: loaded as any,
    dependencies: foreignDeps,
    now,
  });
  // Superseded failures shipped their deliverable under a different task/PR —
  // see mission-task-superseded.ts. Excluded here so they never drive the
  // mission into a `failing` state; reported separately below instead.
  const failedTasks = failedDeliverables.filter(t => !supersededMap.has(t.id));
  const supersededTasks = failedDeliverables
    .filter(t => supersededMap.has(t.id))
    .map(t => ({ task: t, superseded: supersededMap.get(t.id)! }));

  const input: MissionStateInput = {
    status: String(m.status),
    isHeld: m.isHeld === true,
    executor: m.executor ?? null,
    orchestrationMode: m.orchestrationMode ?? null,
    activeAgents,
    progress,
    health,
    dependsOnMissionId: m.dependsOnMissionId ?? null,
    criteriaEscalatedAt: m.criteriaEscalatedAt ?? null,
    hasPendingDeliverableWork: deliverables.some(
      t => !['completed', 'cancelled', 'failed'].includes(t.status),
    ),
    criteriaGate,
    criteriaItems,
    completion,
    wait,
    workState,
    openTasks: openTasks.map(t => ({
      id: t.id, status: t.status, title: t.title, waitingOnTaskIds: waitingOnOf(t),
      ...(t.status === 'pending' ? { waitingOnPrs: unmetDependencyPrs(t, loadedById) } : {}),
    })),
    localStrand: strand
      ? { ...strand, flipBlockedReason: continueOnRunnerBlockedReason({ status: String(m.status), workspaceId: (m.workspaceId as string | null) ?? null }) }
      : null,
    unmergedPrs: ownerUnmergedPrs(loaded as unknown as MissionCardTaskRow[], now),
    failedTasks: failedTasks.map(t => ({
      id: t.id,
      title: t.title,
      infra: (t.result as Record<string, unknown> | null)?.errorType === 'infra_stalled',
    })),
    deferrals,
    // `merged` carries no outstanding fact — the mission is on its way to
    // completing, not waiting on a PR — so it collapses to null same as no PR
    // at all. `open` / `closed` / `not_opened` are passed through as-is:
    // `mergeFact` is what turns each into honest text (or none).
    missionPr: integrationPr && integrationPr.state !== 'merged'
      ? { state: integrationPr.state, prNumber: integrationPr.prNumber, prUrl: integrationPr.prUrl }
      : null,
    ciRed: deriveCiRedChains(
      (completion?.awaitingMergeDetails ?? []).filter(d => !d.closedUnsuperseded),
      loaded,
    ),
  };

  return {
    view: deriveMissionStateView(input),
    mission: m,
    loaded,
    answerExtras: {
      openTasks: openTasks.map(t => ({
        id: t.id,
        title: t.title,
        status: t.status,
        live: hasLiveWorker(t),
        waitingOn: waitingOnOf(t).map(id => ({ id, title: loadedById.get(id)?.title ?? null })),
      })),
      failedTasks: failedTasks.map(t => ({
        id: t.id,
        title: t.title,
        errorSignature: t.workers?.[0]?.error ? t.workers[0].error.split('\n')[0].slice(0, 200) : null,
      })),
      unmergedPrs: completion.awaitingMergeDetails ?? [],
      dependencyTitle: null,
      supersededTasks: supersededTasks.map(({ task, superseded }) => ({
        id: task.id,
        title: task.title,
        prNumber: superseded.prNumber,
        supersedingTaskId: superseded.supersedingTaskId,
      })),
    },
  };
}

function answerFrom(
  view: MissionStateView,
  subject: ExplainAnswer['subject'],
  history: HistoryNode[],
  because: ExplainAnswer['because'],
  gateHistory: GateHistoryEntry[] = [],
  evidenceObjects: InlineEvidenceObject[] = [],
): ExplainAnswer {
  return {
    subject,
    state: view.kind,
    displayState: view.displayState,
    chip: view.chip,
    waitingOn: view.waitingOn,
    outstanding: view.outstanding,
    situation: view.situation,
    because,
    history,
    nextAction: view.nextAction,
    gateHistory,
    ...(evidenceObjects.length > 0 ? { evidenceObjects } : {}),
    derivedFrom: {
      state: view.derivedFrom.kind,
      waitingOn: view.derivedFrom.waitingOn,
      because: [...new Set(because.map(b => b.derivedFrom))],
      history: history.length > 0 ? 'tasks.parentTaskId + tasks.taskClass (attachAttempts)' : null,
      nextAction: view.derivedFrom.nextAction,
      gateHistory: gateHistory.length > 0 ? 'gate_events.taskId' : null,
    },
  };
}

export async function explainMission(missionId: string): Promise<ExplainResult | null> {
  const loadedMission = await viewForMission(missionId);
  if (!loadedMission) return null;
  const { view, mission, loaded, answerExtras } = loadedMission;

  // Name the upstream mission rather than pointing at a UUID.
  if (view.waitingOn?.kind === 'dependency') {
    const upstream = await db.query.missions.findFirst({
      where: eq(missions.id, view.waitingOn.missionId),
      columns: { title: true },
    });
    answerExtras.dependencyTitle = upstream?.title ?? null;
  }

  const subject: ExplainAnswer['subject'] = {
    scope: 'mission',
    id: missionId,
    label: String(mission.title ?? missionId),
    workspaceId: (mission.workspaceId as string) ?? null,
    missionId,
    taskId: null,
    prNumber: null,
  };

  const because = buildStateBecause(
    view,
    { missionId, workspaceId: subject.workspaceId },
    answerExtras,
  );

  return { scope: 'mission', subjects: [answerFrom(view, subject, buildHistory(loaded), because)] };
}

// ─── Task scope ───────────────────────────────────────────────────────────────

/**
 * A task answers the same question with the same shape: the accessor's inputs
 * are simply scoped to this one row and its attempts. Feeding it a single-task
 * "mission" is deliberate — a second accessor for tasks is exactly the
 * divergence this whole line of work exists to prevent.
 */
/** Attach "why is it on this backend" when something moved the task (see ExplainAnswer.backendRouting). */
function withBackendRouting(answer: ExplainAnswer, task: { context: Record<string, unknown> | null; backend?: string | null }): ExplainAnswer {
  const routing = describeBackendRouting(task.context, task.backend);
  if (!routing) return answer;
  return {
    ...answer,
    backendRouting: routing,
    derivedFrom: {
      ...answer.derivedFrom,
      backendRouting: routing.source === 'claim'
        ? `tasks.context.${BACKEND_ROUTING_KEY}`
        : 'tasks.context.failedOverFrom + tasks.backend',
    },
  };
}

async function viewForTask(taskId: string): Promise<{
  view: MissionStateView;
  task: LoadedTask;
  family: LoadedTask[];
  /** The whole fix-attempt chain this task sits in, for `history` only — state is still derived from `family`. */
  lineage: LoadedTask[];
  answerExtras: StateBecauseExtras;
  workspaceId: string | null;
  missionId: string | null;
} | null> {
  const task = (await db.query.tasks.findFirst({
    where: eq(tasks.id, taskId),
    columns: { ...TASK_COLUMNS, workspaceId: true, missionId: true, dependsOn: true, backend: true },
    with: { workers: WORKER_WITH },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  })) as any as (LoadedTask & { workspaceId: string | null; missionId: string | null; dependsOn: string[] | null; backend?: string | null }) | undefined;
  if (!task) return null;

  const attempts = (await db.query.tasks.findMany({
    where: eq(tasks.parentTaskId, taskId),
    columns: TASK_COLUMNS,
    with: { workers: WORKER_WITH },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  })) as any as LoadedTask[];

  // The parent mission's executor. A local mission's pending task is waiting
  // for the person's session to claim it, not stalled for want of a runner.
  // A held mission is the pause and wins, so it is not read as local.
  const parentMission = task.missionId
    ? await db.query.missions.findFirst({
        where: eq(missions.id, task.missionId),
        columns: { executor: true, isHeld: true },
      })
    : null;
  const executor = parentMission && !parentMission.isHeld ? parentMission.executor ?? null : null;

  const family = [task as LoadedTask, ...attempts];
  // History reads the whole chain: from an attempt (a CI fix that opened a PR
  // of its own after a failed resume) the direct children alone leave the
  // predecessor PR and its siblings out.
  const lineage = await collectLineage<LoadedTask>(taskId, {
    fetchTask: async (id) =>
      id === taskId
        ? (task as LoadedTask)
        : (((await db.query.tasks.findFirst({
            where: eq(tasks.id, id),
            columns: TASK_COLUMNS,
            with: { workers: WORKER_WITH },
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          })) as any as LoadedTask | undefined) ?? null),
    fetchChildren: async (parentIds) =>
      (await db.query.tasks.findMany({
        where: inArray(tasks.parentTaskId, parentIds),
        columns: TASK_COLUMNS,
        with: { workers: WORKER_WITH },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      })) as any as LoadedTask[],
  });
  const historyTasks = [...new Map([...lineage, ...family].map(t => [t.id, t])).values()];
  // Family scope: the attempts ARE this task's work, so they count here even
  // though mission-scope health (deliverables only) ignores them.
  const health = deriveTaskHealthSignal({}, family, { scope: 'family' });
  const activeAgents = family.flatMap(t => t.workers ?? []).filter(w => LIVE_WORKER_STATUSES.has(w.status)).length;

  const worker = task.workers?.[0];
  // A PR recorded as superseded (task fcaf83d5) shipped anyway, under a
  // different, merged PR — verified against GitHub at write time, so it reads
  // as shipped here without a second check. Never awaiting-merge.
  // An abandoned PR (closed, with a person's reason) is settled, not awaiting.
  const unmergedPr = task.status === 'completed' && worker?.prNumber && !worker.mergedAt && !worker.supersededByPrNumber
    && !(worker.prLifecycleStatus === 'closed' && worker.abandonedAt)
    ? [{
        taskId: task.id,
        title: task.title,
        prNumber: worker.prNumber,
        prUrl: worker.prUrl,
        ...(worker.prLifecycleStatus === 'closed' ? { closedUnsuperseded: true as const } : {}),
        ...(worker.prLifecycleStatus === 'closed' && worker.supersessionScan?.suggestion
          ? { suggestion: worker.supersessionScan.suggestion }
          : {}),
      }]
    : [];

  // The newest open fix attempt (builder-after-review, CI retry). While one is
  // open the PR is about to change, so it — not the merge — is what this task
  // is waiting on. Without this the task read "waiting on you to merge" while a
  // request-changes fix sat queued for a worker.
  const openAttempt = deriveOpenAttempt(attempts);

  const terminal = ['completed', 'failed', 'cancelled'].includes(task.status);
  const openTasks = OPEN_TASK_STATUSES.has(task.status)
    ? [{ id: task.id, status: task.status, title: task.title }]
    : openAttempt
      ? [{ id: openAttempt.taskId, status: openAttempt.status, title: openAttempt.title }]
      : [];
  const failedTasks = family.filter(t => t.status === 'failed');

  const input: MissionStateInput = {
    // A cancelled task is closed, not idle. `completed` is only terminal for
    // this view once its PR has landed — the merge rule below decides that.
    status: task.status === 'cancelled' || (task.status === 'completed' && unmergedPr.length === 0 && !openAttempt)
      ? 'completed'
      : 'active',
    openAttempt,
    isHeld: false,
    executor,
    activeAgents,
    health,
    progress: terminal ? 100 : undefined,
    openTasks,
    failedTasks: failedTasks.map(t => ({
      id: t.id,
      title: t.title,
      infra: (t.result as Record<string, unknown> | null)?.errorType === 'infra_stalled',
    })),
    wait: classifyMissionWait(family as unknown as WaitClassifiableTask[]),
    ciRed: deriveCiRedChains(unmergedPr.filter(p => !p.closedUnsuperseded), family),
    completion: unmergedPr.length > 0 && !openAttempt
      ? {
          ok: false,
          code: 'awaiting_merge',
          reason: unmergedPr[0].closedUnsuperseded
            ? `Task completed but PR #${unmergedPr[0].prNumber} closed unmerged, no supersession recorded`
            : `Task completed but PR #${unmergedPr[0].prNumber} has not merged`,
          awaitingMerge: 1,
          awaitingMergeDetails: unmergedPr,
        }
      : null,
  };

  return {
    view: deriveMissionStateView(input),
    task: task as LoadedTask,
    family,
    lineage: historyTasks,
    workspaceId: task.workspaceId ?? null,
    missionId: task.missionId ?? null,
    answerExtras: {
      openTasks: openTasks.map(t => ({ id: t.id, title: t.title, status: t.status, live: family.some(f => f.id === t.id && hasLiveWorker(f)) })),
      failedTasks: failedTasks.map(t => ({
        id: t.id,
        title: t.title,
        errorSignature: t.workers?.[0]?.error ? t.workers[0].error.split('\n')[0].slice(0, 200) : null,
      })),
      unmergedPrs: unmergedPr,
    },
  };
}

/**
 * `actor` is who the inline evidence list is audited to. Reach is the caller's
 * job: GET /api/explain has already decided the actor can read the workspace.
 */
export async function explainTask(taskId: string, actor: EvidenceActor): Promise<ExplainResult | null> {
  const loaded = await viewForTask(taskId);
  if (!loaded) return null;
  const { view, task, lineage, answerExtras, workspaceId, missionId } = loaded;

  const subject: ExplainAnswer['subject'] = {
    scope: 'task',
    id: taskId,
    label: task.title,
    workspaceId,
    missionId,
    taskId,
    prNumber: task.workers?.[0]?.prNumber ?? null,
  };

  const because = buildStateBecause(view, { taskId, missionId, workspaceId }, answerExtras);
  const gateHistory = await loadGateHistory(taskId);
  const evidenceObjects = workspaceId
    ? await loadInlineEvidence(workspaceId, taskId, { surface: 'explain', actor })
    : [];
  return { scope: 'task', subjects: [withBackendRouting(answerFrom(view, subject, buildHistory(lineage), because, gateHistory, evidenceObjects), task)] };
}

// ─── PR scope ─────────────────────────────────────────────────────────────────

/**
 * The base-side merges that could have conflicted with a PR: workers in the
 * same workspace whose PR merged into the same base after this one opened.
 *
 * `workers.mergedAt` + `workers.prBaseRef` are the authoritative edges. No
 * GitHub call, no git command.
 */
async function loadBaseSideMerges(input: {
  workspaceId: string;
  baseRef: string;
  since: Date;
  excludeWorkerId: string;
}): Promise<BaseSideMerge[]> {
  const rows = await db.query.workers.findMany({
    where: and(
      eq(workers.workspaceId, input.workspaceId),
      eq(workers.prBaseRef, input.baseRef),
      isNotNull(workers.mergedAt),
      gt(workers.mergedAt, input.since),
      ne(workers.id, input.excludeWorkerId),
    ),
    columns: {
      id: true, taskId: true, prNumber: true, branch: true,
      mergedAt: true, lastCommitSha: true, observedTouches: true,
    },
    orderBy: (w, { desc: d }) => [d(w.mergedAt)],
    limit: BASE_SIDE_LIMIT,
  });
  if (rows.length === 0) return [];

  const taskIds = rows.map(r => r.taskId).filter((t): t is string => !!t);
  const taskRows = taskIds.length > 0
    ? await db.query.tasks.findMany({
        where: inArray(tasks.id, taskIds),
        columns: { id: true, title: true, pathManifest: true },
      })
    : [];
  const taskById = new Map(taskRows.map(t => [t.id, t]));

  return rows.map(r => {
    const t = r.taskId ? taskById.get(r.taskId) ?? null : null;
    const { touches, touchSource } = touchSetOf(
      t ? { pathManifest: (t.pathManifest as string[] | null) ?? null } : null,
      { observedTouches: (r.observedTouches as string[] | null) ?? null },
    );
    return {
      prNumber: r.prNumber ?? null,
      taskId: r.taskId ?? null,
      title: t?.title ?? null,
      branch: r.branch ?? null,
      mergedAt: iso(r.mergedAt),
      headSha: r.lastCommitSha ?? null,
      touches,
      touchSource,
    };
  });
}

/**
 * Explain a PR. The state answer is its task's (a PR is not a separate subject
 * with its own lifecycle — it is how a task ships), and when the PR is
 * conflicted the conflict chain is prepended so `because[]` opens on the cause.
 */
export async function explainPr(worker: {
  id: string;
  taskId: string | null;
  workspaceId: string;
  prNumber: number | null;
  prUrl: string | null;
  branch: string | null;
  prBaseRef: string | null;
  prLifecycleStatus: string | null;
  conflictDetectedAt: Date | string | null;
  prOpenedBaseSha: string | null;
  mergedAt: Date | string | null;
  observedTouches: string[] | null;
  createdAt: Date | string | null;
}, actor: EvidenceActor): Promise<ExplainResult | null> {
  if (!worker.taskId || worker.prNumber == null) return null;

  const loaded = await viewForTask(worker.taskId);
  if (!loaded) return null;
  const { view, task, lineage, answerExtras, workspaceId, missionId } = loaded;

  const subject: ExplainAnswer['subject'] = {
    scope: 'pr',
    id: String(worker.prNumber),
    label: `PR #${worker.prNumber}: ${task.title}`,
    workspaceId: workspaceId ?? worker.workspaceId,
    missionId,
    taskId: worker.taskId,
    prNumber: worker.prNumber,
  };

  let because = buildStateBecause(view, { taskId: worker.taskId, missionId, workspaceId }, answerExtras);

  // `mergeable: dirty` is stored locally as prLifecycleStatus='conflict'
  // (kept live by the GitHub webhook), so naming the cause needs no API call.
  if (worker.prLifecycleStatus === 'conflict' && !worker.mergedAt) {
    const { touches, touchSource } = touchSetOf(
      { pathManifest: task.pathManifest },
      { observedTouches: worker.observedTouches },
    );
    const openedAt = worker.createdAt ? new Date(worker.createdAt) : null;
    const baseSide = worker.prBaseRef && openedAt
      ? await loadBaseSideMerges({
          workspaceId: worker.workspaceId,
          baseRef: worker.prBaseRef,
          since: openedAt,
          excludeWorkerId: worker.id,
        })
      : [];

    const conflict: ConflictSubject = {
      prNumber: worker.prNumber,
      taskId: worker.taskId,
      branch: worker.branch,
      baseRef: worker.prBaseRef,
      lifecycleStatus: worker.prLifecycleStatus,
      conflictDetectedAt: iso(worker.conflictDetectedAt),
      openedBaseSha: worker.prOpenedBaseSha,
      openedAt: iso(openedAt),
      touches,
      touchSource,
    };

    const explanation = buildConflictBecause(conflict, baseSide);
    // Conflict cause first, then the task-state chain: the chain still reads
    // cause → effect end to end.
    because = orderChain([
      ...explanation.links.map(({ order: _order, ...rest }) => rest),
      ...because.map(({ order: _order, ...rest }) => rest),
    ]);
  }

  // A PR ships through its task, so its gate ledger (merge_base_freshness
  // rejections, review_verdict deferrals) is the task's.
  const gateHistory = await loadGateHistory(worker.taskId);
  const evidenceObjects = await loadInlineEvidence(worker.workspaceId, worker.taskId, { surface: 'explain', actor });
  return { scope: 'pr', subjects: [withBackendRouting(answerFrom(view, subject, buildHistory(lineage), because, gateHistory, evidenceObjects), task)] };
}

// ─── Workspace scope ──────────────────────────────────────────────────────────

/**
 * Every subject in the workspace that is waiting on something, ranked — never
 * a dump of everything. A workspace with nothing blocked returns an empty
 * `subjects` with `quiet` set, which is a different and equally useful answer.
 *
 * Subjects are missions plus the workspace's mission-less tasks: a task inside
 * a mission is already represented by its mission's chain, and listing both
 * would put the same blocker on screen twice.
 */
export async function explainWorkspace(workspaceId: string, actor: EvidenceActor): Promise<ExplainResult> {
  const activeMissions = await db.query.missions.findMany({
    where: and(eq(missions.workspaceId, workspaceId), eq(missions.status, 'active')),
    columns: { id: true },
    // Same scan cap as the orphan-tasks query below — without it, a workspace
    // with many active missions fans out one explainMission() call (several
    // queries each) per mission before the WORKSPACE_SUBJECT_LIMIT ranking cut
    // ever applies, so the bound on subjects RETURNED did nothing to bound the
    // work PERFORMED to produce them.
    limit: MISSION_SCAN_LIMIT,
  });

  const orphanTasks = await db.query.tasks.findMany({
    where: and(
      eq(tasks.workspaceId, workspaceId),
      inArray(tasks.status, ['pending', 'assigned', 'in_progress', 'completed']),
    ),
    columns: { id: true, missionId: true, taskClass: true },
    limit: 200,
  });
  const missionLessIds = orphanTasks
    .filter(t => !t.missionId && t.taskClass !== 'attempt')
    .map(t => t.id);

  // One bounded fan-out across missions and mission-less tasks together, so the
  // concurrency cap holds across both rather than doubling at the boundary.
  const fanoutItems: Array<{ kind: 'mission' | 'task'; id: string }> = [
    ...activeMissions.map(m => ({ kind: 'mission' as const, id: m.id })),
    ...missionLessIds.map(id => ({ kind: 'task' as const, id })),
  ];
  const results = await mapWithConcurrency(fanoutItems, WORKSPACE_FANOUT_CONCURRENCY, item =>
    item.kind === 'mission' ? explainMission(item.id) : explainTask(item.id, actor),
  );
  const answers: ExplainAnswer[] = results.flatMap(r => (r?.subjects[0] ? [r.subjects[0]] : []));

  const ranked = rankGatedSubjects(answers).slice(0, WORKSPACE_SUBJECT_LIMIT);
  const gatedTotal = answers.filter(a => a.waitingOn !== null).length;
  if (gatedTotal > ranked.length || activeMissions.length === MISSION_SCAN_LIMIT) {
    // No silent caps: say what was dropped rather than implying full coverage.
    console.info(
      `[explain] workspace ${workspaceId}: ${gatedTotal} gated subjects, returning top ${ranked.length}` +
        (activeMissions.length === MISSION_SCAN_LIMIT ? ` (mission scan hit the ${MISSION_SCAN_LIMIT} cap)` : ''),
    );
  }

  return {
    scope: 'workspace',
    subjects: ranked,
    considered: answers.length,
    quiet: answers.length - gatedTotal,
  };
}
