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
import { db } from '@buildd/core/db';
import { missions, tasks, workers } from '@buildd/core/db/schema';
import { and, desc, eq, gt, inArray, isNotNull, ne } from 'drizzle-orm';
import { deriveCriteriaGatePresentation, attachAttempts, isDeliverableTask } from '@buildd/core/mission-helpers';
import { deriveTaskHealthSignal } from '@/lib/mission-helpers';
import { canCompleteMission } from '@/lib/mission-completion';
import { classifyMissionWait, type WaitClassifiableTask } from '@/lib/heartbeat-prepass';
import { evaluateMissionWorkState } from '@/lib/mission-pr';
import { deriveMissionStateView, type MissionStateInput, type MissionStateView } from '@/lib/mission-state-view';
import { REPO_WIDE_SENTINEL } from '@buildd/core/path-overlap';
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
} from '@/lib/explain-types';

/** Cap on how many gated subjects a workspace answer returns. */
const WORKSPACE_SUBJECT_LIMIT = 12;
/** Cap on base-side merges examined for a conflicted PR. */
const BASE_SIDE_LIMIT = 40;

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
  pathManifest: string[] | null;
  context: Record<string, unknown> | null;
  startAt: Date | null;
  loopConfig: unknown;
  loopState: unknown;
  result: unknown;
  createdAt: Date | null;
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
  }>;
};

const TASK_COLUMNS = {
  id: true, title: true, status: true, mode: true, kind: true, taskClass: true,
  parentTaskId: true, creationSource: true, category: true, pathManifest: true,
  context: true, startAt: true, loopConfig: true, loopState: true, result: true,
  createdAt: true,
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
  },
  orderBy: [desc(workers.startedAt)],
};

const LIVE_WORKER_STATUSES = new Set(['idle', 'running', 'starting', 'waiting_input']);
const OPEN_TASK_STATUSES = new Set(['pending', 'assigned', 'in_progress']);

function iso(d: Date | string | null | undefined): string | null {
  if (!d) return null;
  return d instanceof Date ? d.toISOString() : new Date(d).toISOString();
}

function prStateOf(w: LoadedTask['workers'][number] | undefined): HistoryNode['prState'] {
  if (!w?.prNumber) return 'none';
  if (w.mergedAt) return 'merged';
  if (w.prLifecycleStatus === 'conflict') return 'conflict';
  if (w.prLifecycleStatus === 'closed' || w.prLifecycleStatus === 'unresolvable') return 'closed';
  return 'open';
}

/**
 * Attempts collapsed under their parent via `parentTaskId` + `taskClass`.
 * Nesting is read through `attachAttempts` (PR #1674) — not re-derived here.
 */
function buildHistory(loaded: LoadedTask[]): HistoryNode[] {
  const attemptsByParent = attachAttempts(loaded);
  const toNode = (t: LoadedTask, attempts: HistoryNode[]): HistoryNode => {
    const w = t.workers?.[0];
    return {
      taskId: t.id,
      title: t.title,
      status: t.status,
      taskClass: t.taskClass,
      prNumber: w?.prNumber ?? null,
      prState: prStateOf(w),
      createdAt: iso(t.createdAt),
      attempts,
    };
  };

  return loaded
    .filter(t => t.taskClass !== 'attempt')
    .sort((a, b) => (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0))
    .map(t =>
      toNode(
        t,
        (attemptsByParent.get(t.id) ?? [])
          .sort((a, b) => (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0))
          .map(a => toNode(a, [])),
      ),
    );
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

  const health = deriveTaskHealthSignal({ ...m, heartbeatWaitingUntil }, loaded);

  const deliverables = loaded.filter(isDeliverableTask);
  const completedDeliverables = deliverables.filter(t => t.status === 'completed').length;
  const progress = deliverables.length > 0
    ? Math.round((completedDeliverables / deliverables.length) * 100)
    : undefined;

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

  const activeAgents = loaded.flatMap(t => t.workers ?? []).filter(w => LIVE_WORKER_STATUSES.has(w.status)).length;
  const openTasks = deliverables.filter(t => OPEN_TASK_STATUSES.has(t.status));
  const failedTasks = deliverables.filter(t => t.status === 'failed');

  const input: MissionStateInput = {
    status: String(m.status),
    isHeld: m.isHeld === true,
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
    openTasks: openTasks.map(t => ({ id: t.id, status: t.status, title: t.title })),
    failedTasks: failedTasks.map(t => ({
      id: t.id,
      title: t.title,
      infra: (t.result as Record<string, unknown> | null)?.errorType === 'infra_stalled',
    })),
  };

  return {
    view: deriveMissionStateView(input),
    mission: m,
    loaded,
    answerExtras: {
      openTasks: openTasks.map(t => ({ id: t.id, title: t.title, status: t.status })),
      failedTasks: failedTasks.map(t => ({
        id: t.id,
        title: t.title,
        errorSignature: t.workers?.[0]?.error ? t.workers[0].error.split('\n')[0].slice(0, 200) : null,
      })),
      unmergedPrs: completion.awaitingMergeDetails ?? [],
      dependencyTitle: null,
    },
  };
}

function answerFrom(
  view: MissionStateView,
  subject: ExplainAnswer['subject'],
  history: HistoryNode[],
  because: ExplainAnswer['because'],
): ExplainAnswer {
  return {
    subject,
    state: view.kind,
    waitingOn: view.waitingOn,
    because,
    history,
    nextAction: view.nextAction,
    derivedFrom: {
      state: view.derivedFrom.kind,
      waitingOn: view.derivedFrom.waitingOn,
      because: [...new Set(because.map(b => b.derivedFrom))],
      history: history.length > 0 ? 'tasks.parentTaskId + tasks.taskClass (attachAttempts)' : null,
      nextAction: view.derivedFrom.nextAction,
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
async function viewForTask(taskId: string): Promise<{
  view: MissionStateView;
  task: LoadedTask;
  family: LoadedTask[];
  answerExtras: StateBecauseExtras;
  workspaceId: string | null;
  missionId: string | null;
} | null> {
  const task = (await db.query.tasks.findFirst({
    where: eq(tasks.id, taskId),
    columns: { ...TASK_COLUMNS, workspaceId: true, missionId: true, dependsOn: true },
    with: { workers: WORKER_WITH },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  })) as any as (LoadedTask & { workspaceId: string | null; missionId: string | null; dependsOn: string[] | null }) | undefined;
  if (!task) return null;

  const attempts = (await db.query.tasks.findMany({
    where: eq(tasks.parentTaskId, taskId),
    columns: TASK_COLUMNS,
    with: { workers: WORKER_WITH },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  })) as any as LoadedTask[];

  const family = [task as LoadedTask, ...attempts];
  const health = deriveTaskHealthSignal({}, family);
  const activeAgents = family.flatMap(t => t.workers ?? []).filter(w => LIVE_WORKER_STATUSES.has(w.status)).length;

  const worker = task.workers?.[0];
  const unmergedPr = task.status === 'completed' && worker?.prNumber && !worker.mergedAt
    ? [{ taskId: task.id, title: task.title, prNumber: worker.prNumber, prUrl: worker.prUrl }]
    : [];

  const terminal = ['completed', 'failed', 'cancelled'].includes(task.status);
  const openTasks = OPEN_TASK_STATUSES.has(task.status)
    ? [{ id: task.id, status: task.status, title: task.title }]
    : [];
  const failedTasks = family.filter(t => t.status === 'failed');

  const input: MissionStateInput = {
    // A cancelled task is closed, not idle. `completed` is only terminal for
    // this view once its PR has landed — the merge rule below decides that.
    status: task.status === 'cancelled' || (task.status === 'completed' && unmergedPr.length === 0)
      ? 'completed'
      : 'active',
    isHeld: false,
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
    completion: unmergedPr.length > 0
      ? {
          ok: false,
          code: 'awaiting_merge',
          reason: `Task completed but PR #${unmergedPr[0].prNumber} has not merged`,
          awaitingMerge: 1,
          awaitingMergeDetails: unmergedPr,
        }
      : null,
  };

  return {
    view: deriveMissionStateView(input),
    task: task as LoadedTask,
    family,
    workspaceId: task.workspaceId ?? null,
    missionId: task.missionId ?? null,
    answerExtras: {
      openTasks: openTasks.map(t => ({ id: t.id, title: t.title, status: t.status })),
      failedTasks: failedTasks.map(t => ({
        id: t.id,
        title: t.title,
        errorSignature: t.workers?.[0]?.error ? t.workers[0].error.split('\n')[0].slice(0, 200) : null,
      })),
      unmergedPrs: unmergedPr,
    },
  };
}

export async function explainTask(taskId: string): Promise<ExplainResult | null> {
  const loaded = await viewForTask(taskId);
  if (!loaded) return null;
  const { view, task, family, answerExtras, workspaceId, missionId } = loaded;

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
  return { scope: 'task', subjects: [answerFrom(view, subject, buildHistory(family), because)] };
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
}): Promise<ExplainResult | null> {
  if (!worker.taskId || worker.prNumber == null) return null;

  const loaded = await viewForTask(worker.taskId);
  if (!loaded) return null;
  const { view, task, family, answerExtras, workspaceId, missionId } = loaded;

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

  return { scope: 'pr', subjects: [answerFrom(view, subject, buildHistory(family), because)] };
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
export async function explainWorkspace(workspaceId: string): Promise<ExplainResult> {
  const activeMissions = await db.query.missions.findMany({
    where: and(eq(missions.workspaceId, workspaceId), eq(missions.status, 'active')),
    columns: { id: true },
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

  const answers: ExplainAnswer[] = [];
  for (const m of activeMissions) {
    const result = await explainMission(m.id);
    if (result?.subjects[0]) answers.push(result.subjects[0]);
  }
  for (const taskId of missionLessIds) {
    const result = await explainTask(taskId);
    if (result?.subjects[0]) answers.push(result.subjects[0]);
  }

  const ranked = rankGatedSubjects(answers).slice(0, WORKSPACE_SUBJECT_LIMIT);
  const gatedTotal = answers.filter(a => a.waitingOn !== null).length;
  if (gatedTotal > ranked.length) {
    // No silent caps: say what was dropped rather than implying full coverage.
    console.info(
      `[explain] workspace ${workspaceId}: ${gatedTotal} gated subjects, returning top ${ranked.length}`,
    );
  }

  return {
    scope: 'workspace',
    subjects: ranked,
    considered: answers.length,
    quiet: answers.length - gatedTotal,
  };
}
