/**
 * The stores half of the orchestration decision/outcome ledger
 * (docs/design/conflict-aware-orchestration.md §5–§6).
 *
 * Split from the pure join (`./orchestration-outcomes.ts`) and the adapter
 * (`./orchestration-decision.ts`) for the reason task-area prediction is: a
 * test that mocks `db` cannot see a WHERE clause, so the predicates are built
 * by exported functions a test renders with the real dialect.
 *
 * Everything here is best-effort and never throws into a request path.
 */
import { and, desc, eq, gte, inArray, isNotNull, lt } from 'drizzle-orm';
import { db } from './db/client';
import {
  gateEvents,
  orchestrationDecisions,
  orchestrationTouchLabels,
  tasks,
  workers,
} from './db/schema';
import type { OrchestrationDecisionRow } from './orchestration-decision';
import {
  COLLISION_GATE,
  MERGE_BASE_GATE,
  normalizeTouchLabel,
  type OutcomeJoinInput,
} from './orchestration-outcomes';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuidOrNull = (v: string | null | undefined): string | null => (typeof v === 'string' && UUID_RE.test(v) ? v : null);

/** Bound on decisions loaded per readout call. */
export const OUTCOME_JOIN_MAX_DECISIONS = 5_000;

// ── Writes ───────────────────────────────────────────────────────────────────

/** Persist one decision row. Never throws. */
export async function recordOrchestrationDecision(row: OrchestrationDecisionRow): Promise<void> {
  try {
    await db.insert(orchestrationDecisions).values({
      ...row,
      missionId: uuidOrNull(row.missionId),
      taskId: uuidOrNull(row.taskId),
      workerId: uuidOrNull(row.workerId),
      receipt: (row.receipt as unknown as Record<string, unknown> | null) ?? null,
    });
  } catch (err) {
    console.warn('[orchestration-ledger] decision insert failed (non-fatal):', (err as Error)?.message ?? err);
  }
}

export interface TouchLabelInput {
  taskId: string;
  workspaceId: string;
  workerId: string | null;
  workerStatus: string;
  /** The final observation: accumulated observed touches plus this PATCH's paths. */
  paths: readonly unknown[];
  prNumber?: number | null;
  headSha?: string | null;
  baseRef?: string | null;
}

/**
 * Persist a worker session's final touched-file label, for a task that an
 * orchestration decision looked at. Call it at terminal status BEFORE the
 * observation column is cleared. Returns whether a label was written.
 * Never throws; one cheap read for an undecided task, nothing else.
 */
export async function recordOrchestrationTouchLabel(input: TouchLabelInput): Promise<boolean> {
  const taskId = uuidOrNull(input.taskId);
  const workspaceId = uuidOrNull(input.workspaceId);
  if (!taskId || !workspaceId) return false;
  try {
    const decided = await db
      .select({ id: orchestrationDecisions.id })
      .from(orchestrationDecisions)
      .where(decidedTaskWhere({ taskId, workspaceId }))
      .limit(1);
    if (decided.length === 0) return false;
    const { paths, truncated } = normalizeTouchLabel(input.paths);
    await db.insert(orchestrationTouchLabels).values({
      taskId,
      workspaceId,
      workerId: uuidOrNull(input.workerId),
      workerStatus: input.workerStatus,
      touchedPaths: paths,
      truncated,
      prNumber: input.prNumber ?? null,
      headSha: input.headSha ?? null,
      baseRef: input.baseRef ?? null,
    }).onConflictDoNothing({ target: [orchestrationTouchLabels.taskId, orchestrationTouchLabels.workerId] });
    return true;
  } catch (err) {
    console.warn('[orchestration-ledger] touch label failed (non-fatal):', (err as Error)?.message ?? err);
    return false;
  }
}

// ── Predicates (rendered by the tests) ───────────────────────────────────────

export function decidedTaskWhere(opts: { taskId: string; workspaceId: string }) {
  return and(eq(orchestrationDecisions.taskId, opts.taskId), eq(orchestrationDecisions.workspaceId, opts.workspaceId));
}

export function decisionsWhere(opts: { workspaceId: string; since: Date; until: Date; decisionId?: string }) {
  return and(
    eq(orchestrationDecisions.workspaceId, opts.workspaceId),
    gte(orchestrationDecisions.createdAt, opts.since),
    lt(orchestrationDecisions.createdAt, opts.until),
    ...(opts.decisionId ? [eq(orchestrationDecisions.decisionId, opts.decisionId)] : []),
  );
}

export function tasksWhere(opts: { workspaceId: string; taskIds: string[] }) {
  return and(eq(tasks.workspaceId, opts.workspaceId), inArray(tasks.id, opts.taskIds));
}

export function labelsWhere(opts: { workspaceId: string; taskIds: string[] }) {
  return and(eq(orchestrationTouchLabels.workspaceId, opts.workspaceId), inArray(orchestrationTouchLabels.taskId, opts.taskIds));
}

export function prWorkersWhere(opts: { workspaceId: string; taskIds: string[] }) {
  return and(eq(workers.workspaceId, opts.workspaceId), inArray(workers.taskId, opts.taskIds), isNotNull(workers.prNumber));
}

export function conflictTasksWhere(opts: { workspaceId: string; prNumbers: number[]; since: Date }) {
  return and(
    eq(tasks.workspaceId, opts.workspaceId),
    inArray(tasks.conflictRetryPrNumber, opts.prNumbers),
    gte(tasks.createdAt, opts.since),
  );
}

export function outcomeGateEventsWhere(opts: { workspaceId: string; since: Date }) {
  return and(
    eq(gateEvents.workspaceId, opts.workspaceId),
    inArray(gateEvents.gate, [COLLISION_GATE, MERGE_BASE_GATE]),
    gte(gateEvents.occurredAt, opts.since),
  );
}

// ── Readout input ────────────────────────────────────────────────────────────

/**
 * Load everything `labelDecisionOutcomes` needs for one workspace's decisions
 * in a window. Each read is workspace-scoped; an empty id list skips the read
 * rather than issuing an `IN ()`.
 */
export async function loadOrchestrationOutcomeInput(opts: {
  workspaceId: string;
  since: Date;
  until: Date;
  decisionId?: string;
}): Promise<OutcomeJoinInput> {
  const decisions = (await db
    .select({
      id: orchestrationDecisions.id,
      taskId: orchestrationDecisions.taskId,
      workspaceId: orchestrationDecisions.workspaceId,
      prNumber: orchestrationDecisions.prNumber,
      headSha: orchestrationDecisions.headSha,
      baseRef: orchestrationDecisions.baseRef,
      createdAt: orchestrationDecisions.createdAt,
    })
    .from(orchestrationDecisions)
    .where(decisionsWhere(opts))
    .limit(OUTCOME_JOIN_MAX_DECISIONS)) as OutcomeJoinInput['decisions'];

  const empty: OutcomeJoinInput = { decisions, tasks: [], labels: [], prs: [], conflictTasks: [], gateEvents: [] };
  const taskIds = [...new Set(decisions.map(d => d.taskId).filter((t): t is string => !!t))];
  if (taskIds.length === 0) return empty;
  const scope = { workspaceId: opts.workspaceId, taskIds };

  const [taskRows, labelRows, prRows, events] = await Promise.all([
    db.select({ id: tasks.id, workspaceId: tasks.workspaceId, status: tasks.status }).from(tasks).where(tasksWhere(scope)),
    db.select({
      taskId: orchestrationTouchLabels.taskId,
      workerId: orchestrationTouchLabels.workerId,
      workerStatus: orchestrationTouchLabels.workerStatus,
      touchedPaths: orchestrationTouchLabels.touchedPaths,
      truncated: orchestrationTouchLabels.truncated,
      prNumber: orchestrationTouchLabels.prNumber,
      headSha: orchestrationTouchLabels.headSha,
      baseRef: orchestrationTouchLabels.baseRef,
      recordedAt: orchestrationTouchLabels.recordedAt,
    }).from(orchestrationTouchLabels).where(labelsWhere(scope)),
    db.select({
      taskId: workers.taskId,
      workspaceId: workers.workspaceId,
      prNumber: workers.prNumber,
      headSha: workers.lastCommitSha,
      baseRef: workers.prBaseRef,
      mergedAt: workers.mergedAt,
      lifecycle: workers.prLifecycleStatus,
      createdAt: workers.createdAt,
    }).from(workers).where(prWorkersWhere(scope)).orderBy(workers.createdAt),
    db.select({
      gate: gateEvents.gate,
      outcome: gateEvents.outcome,
      workspaceId: gateEvents.workspaceId,
      taskId: gateEvents.taskId,
      occurredAt: gateEvents.occurredAt,
      detail: gateEvents.detail,
    }).from(gateEvents).where(outcomeGateEventsWhere({ workspaceId: opts.workspaceId, since: opts.since })).orderBy(desc(gateEvents.occurredAt)),
  ]);

  const prNumbers = [...new Set([
    ...decisions.map(d => d.prNumber),
    ...(prRows as { prNumber: number | null }[]).map(p => p.prNumber),
  ].filter((n): n is number => typeof n === 'number'))];
  const conflictRows = prNumbers.length === 0 ? [] : await db.select({
    id: tasks.id,
    workspaceId: tasks.workspaceId,
    prNumber: tasks.conflictRetryPrNumber,
    headSha: tasks.conflictRetryHeadSha,
    createdAt: tasks.createdAt,
  }).from(tasks).where(conflictTasksWhere({ workspaceId: opts.workspaceId, prNumbers, since: opts.since }));

  return {
    decisions,
    tasks: taskRows as OutcomeJoinInput['tasks'],
    labels: labelRows as OutcomeJoinInput['labels'],
    prs: (prRows as Array<OutcomeJoinInput['prs'][number] & { taskId: string | null }>).filter(p => p.taskId) as OutcomeJoinInput['prs'],
    conflictTasks: conflictRows as OutcomeJoinInput['conflictTasks'],
    gateEvents: events as OutcomeJoinInput['gateEvents'],
  };
}
