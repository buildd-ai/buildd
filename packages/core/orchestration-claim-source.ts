/**
 * Stores for hold/start at claim (knowledge-base: buildd/design/conflict-aware-orchestration.md
 * §5b, §6). Split from the pure half (./orchestration-claim-decision.ts) so
 * every predicate is an exported function a test renders with the real
 * dialect.
 *
 * None of this runs on the claim response path by default:
 *  - `hasRecentClaimDecision` and `loadClaimHolderState` run after the
 *    response (`after()`), inside the shadow dispatch.
 *  - `findAppliedStart` is the gated-START lookup; the claim route calls it
 *    only when `isGatedStartReachable()` is true, which it is not as shipped.
 */
import { and, desc, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import { db } from './db/client';
import { gateEvents, orchestrationDecisions, orchestrationManifestPredictions, reviewFeedback, tasks, workers } from './db/schema';
import { GATE_SLUGS } from './gate-events';
import { CLAIM_HOLD_DECISION, deriveHolderStage, summarizeFileConflictHistory } from './orchestration-claim-decision';
import type { ClaimHoldEvidence, ClaimHoldHolderState, FileConflictCount } from './orchestration-claim-decision';
import type { ClaimDecisionForReadout, ClaimHoldReadoutInput, TaskStartForReadout } from './orchestration-claim-readout';
import { labelDecisionOutcomes } from './orchestration-outcomes';
import type { SiblingProbeEventForReadout, SoftStartForReadout, SoftStartReadoutInput } from './orchestration-soft-start-readout';

export const CLAIM_HOLD_CAPABILITY = 'orchestration_claim';

/** Bound on decisions loaded per readout call. */
export const CLAIM_HOLD_READOUT_MAX_DECISIONS = 5_000;

export interface ClaimDecisionKey {
  workspaceId: string;
  taskId: string;
  decisionId: string;
  fingerprint: string;
  candidateDigest: string;
  since: Date;
}

// ── Predicates ───────────────────────────────────────────────────────────────

export function recentClaimDecisionWhere(k: ClaimDecisionKey) {
  return and(
    eq(orchestrationDecisions.workspaceId, k.workspaceId),
    eq(orchestrationDecisions.taskId, k.taskId),
    eq(orchestrationDecisions.decisionId, k.decisionId),
    eq(orchestrationDecisions.fingerprint, k.fingerprint),
    eq(orchestrationDecisions.candidateDigest, k.candidateDigest),
    gte(orchestrationDecisions.createdAt, k.since),
  );
}

export function appliedStartWhere(k: ClaimDecisionKey) {
  return and(
    recentClaimDecisionWhere(k),
    eq(orchestrationDecisions.applied, true),
    eq(orchestrationDecisions.effective, 'START'),
    eq(orchestrationDecisions.experimentArm, 'apply'),
  );
}

export function holderWorkersWhere(opts: { workspaceId: string; taskId: string }) {
  return and(eq(workers.workspaceId, opts.workspaceId), eq(workers.taskId, opts.taskId));
}

export function holderTaskWhere(opts: { workspaceId: string; taskId: string }) {
  return and(eq(tasks.workspaceId, opts.workspaceId), eq(tasks.id, opts.taskId));
}

export function claimDecisionsWhere(opts: { workspaceId: string; since: Date; until: Date }) {
  return and(
    eq(orchestrationDecisions.workspaceId, opts.workspaceId),
    eq(orchestrationDecisions.capability, CLAIM_HOLD_CAPABILITY),
    eq(orchestrationDecisions.decisionId, CLAIM_HOLD_DECISION.id),
    gte(orchestrationDecisions.createdAt, opts.since),
    lt(orchestrationDecisions.createdAt, opts.until),
  );
}

export function claimStartsWhere(opts: { workspaceId: string; taskIds: string[]; since: Date }) {
  return and(
    eq(workers.workspaceId, opts.workspaceId),
    inArray(workers.taskId, opts.taskIds),
    gte(workers.createdAt, opts.since),
  );
}

// ── Reads ────────────────────────────────────────────────────────────────────

/** Gated START: an applied START for this exact claim-time state, still fresh. False on any error. */
export async function findAppliedStart(k: ClaimDecisionKey): Promise<boolean> {
  try {
    const rows = await db.select({ id: orchestrationDecisions.id }).from(orchestrationDecisions).where(appliedStartWhere(k)).limit(1);
    return rows.length > 0;
  } catch (err) {
    console.warn('[orchestration-claim] applied-start lookup failed (holding):', (err as Error)?.message ?? err);
    return false;
  }
}

/**
 * Was this exact state already asked about recently? A failed read answers
 * true: re-asking on every poll because the ledger is unreadable would spend
 * on every deferral.
 */
export async function hasRecentClaimDecision(k: ClaimDecisionKey): Promise<boolean> {
  try {
    const rows = await db.select({ id: orchestrationDecisions.id }).from(orchestrationDecisions).where(recentClaimDecisionWhere(k)).limit(1);
    return rows.length > 0;
  } catch (err) {
    console.warn('[orchestration-claim] recent-decision read failed (skipping):', (err as Error)?.message ?? err);
    return true;
  }
}

/**
 * Holder liveness and base freshness, read at decision time. Throws on a DB
 * error on purpose: the adapter turns that into a recorded `retrieval_error`
 * fallback rather than asking the model about a state it could not read.
 */
export async function loadClaimHolderState(opts: { workspaceId: string; taskId: string | null; prNumber: number | null }): Promise<ClaimHoldHolderState | null> {
  if (!opts.taskId) return null;
  const scope = { workspaceId: opts.workspaceId, taskId: opts.taskId };
  const [workerRows, taskRows] = await Promise.all([
    db.select({
      status: workers.status,
      updatedAt: workers.updatedAt,
      startedAt: workers.startedAt,
      prLifecycleStatus: workers.prLifecycleStatus,
      prNumber: workers.prNumber,
    }).from(workers).where(holderWorkersWhere(scope)).orderBy(desc(workers.updatedAt)).limit(5),
    db.select({ title: tasks.title }).from(tasks).where(holderTaskWhere(scope)).limit(1),
  ]);
  const rows = workerRows as Array<{ status: string; updatedAt: Date | null; startedAt?: Date | null; prLifecycleStatus: string | null; prNumber: number | null }>;
  const w = (opts.prNumber !== null ? rows.find(r => r.prNumber === opts.prNumber) : undefined) ?? rows[0];
  const lifecycle = w?.prLifecycleStatus ?? null;
  const prNumber = w?.prNumber ?? null;
  // Approved = the newest top-level review on the holder's PR approves it.
  let approved = false;
  if (prNumber !== null) {
    const reviews = await db.select({ state: reviewFeedback.state })
      .from(reviewFeedback)
      .where(holderReviewWhere({ workspaceId: opts.workspaceId, prNumber }))
      .orderBy(desc(reviewFeedback.submittedAt))
      .limit(1);
    approved = (reviews as Array<{ state: string | null }>)[0]?.state === 'approved';
  }
  return {
    title: (taskRows as Array<{ title: string | null }>)[0]?.title ?? null,
    workerStatus: w?.status ?? null,
    lastActivityAt: w?.updatedAt ? new Date(w.updatedAt).toISOString() : null,
    prLifecycle: lifecycle,
    baseStale: lifecycle === null ? null : lifecycle === 'conflict' || lifecycle === 'unresolvable',
    stage: deriveHolderStage({
      workerStatus: w?.status ?? null,
      startedAt: w?.startedAt ? new Date(w.startedAt).toISOString() : null,
      prNumber,
      prLifecycle: lifecycle,
      approved,
      now: new Date().toISOString(),
    }),
  };
}

export function holderReviewWhere(opts: { workspaceId: string; prNumber: number }) {
  return and(
    eq(reviewFeedback.workspaceId, opts.workspaceId),
    eq(reviewFeedback.prNumber, opts.prNumber),
    eq(reviewFeedback.kind, 'review'),
    inArray(reviewFeedback.state, ['approved', 'changes_requested']),
  );
}

/** How far back merged-PR history counts toward a file's conflict rate. */
export const FILE_CONFLICT_HISTORY_DAYS = 90;

/**
 * Per-file history for a same-file soft overlap: of the merged PRs whose task
 * touched each file (orchestration_touch_labels joined to a merged worker),
 * how many needed a conflict retry (a task with `conflict_retry_pr_number` on
 * that PR). Plus the candidate's latest recorded expected size. THROWS on a
 * DB error: the decision then falls back to the rule's HOLD.
 */
export async function loadSoftOverlapEvidence(opts: { workspaceId: string; taskId: string; paths: string[] }): Promise<ClaimHoldEvidence> {
  const paths = [...new Set(opts.paths.filter(p => typeof p === 'string' && p.length > 0))].slice(0, 20);
  const since = new Date(Date.now() - FILE_CONFLICT_HISTORY_DAYS * 86_400_000);
  const [countRows, sizeRows] = await Promise.all([
    paths.length === 0 ? Promise.resolve(null) : db.execute(fileConflictCountsSql({ workspaceId: opts.workspaceId, paths, since })),
    db.select({ expectedSize: orchestrationManifestPredictions.expectedSize })
      .from(orchestrationManifestPredictions)
      .where(eq(orchestrationManifestPredictions.taskId, opts.taskId))
      .orderBy(desc(orchestrationManifestPredictions.createdAt))
      .limit(1),
  ]);
  const raw = countRows === null ? [] : (Array.isArray(countRows) ? countRows : (countRows as { rows?: unknown[] }).rows ?? []);
  const counts: FileConflictCount[] = (raw as Array<{ path: string; merged_prs: number | string; conflicted: number | string }>)
    .map(r => ({ path: r.path, mergedPrs: Number(r.merged_prs) || 0, conflicted: Number(r.conflicted) || 0 }));
  const size = (sizeRows as Array<{ expectedSize: { files: number; minutes: number; source: string } | null }>)[0]?.expectedSize ?? null;
  return {
    conflictHistory: paths.length === 0 ? null : summarizeFileConflictHistory(paths, counts),
    predictedChange: size ? { files: size.files, minutes: size.minutes, source: size.source } : null,
  };
}

export function fileConflictCountsSql(opts: { workspaceId: string; paths: string[]; since: Date }) {
  return sql`
    SELECT p.path AS path,
      COUNT(DISTINCT l.pr_number)::int AS merged_prs,
      COUNT(DISTINCT l.pr_number) FILTER (WHERE EXISTS (
        SELECT 1 FROM tasks r
        WHERE r.workspace_id = l.workspace_id AND r.conflict_retry_pr_number = l.pr_number
      ))::int AS conflicted
    FROM orchestration_touch_labels l
    CROSS JOIN LATERAL jsonb_array_elements_text(l.touched_paths) AS p(path)
    JOIN workers w ON w.id = l.worker_id AND w.merged_at IS NOT NULL
    WHERE l.workspace_id = ${opts.workspaceId}
      AND l.pr_number IS NOT NULL
      AND l.recorded_at >= ${opts.since.toISOString()}
      AND p.path IN (SELECT jsonb_array_elements_text(${JSON.stringify(opts.paths)}::jsonb))
    GROUP BY p.path`;
}

/**
 * Everything `summarizeClaimHoldReadout` needs for one workspace's claim
 * decisions in a window: the decision rows, F's outcome labels for them, task
 * statuses and worker starts. Each read is workspace-scoped.
 */
export async function loadClaimHoldReadoutInput(opts: { workspaceId: string; since: Date; until: Date }): Promise<ClaimHoldReadoutInput> {
  const decisions = (await db.select({
    id: orchestrationDecisions.id,
    taskId: orchestrationDecisions.taskId,
    workspaceId: orchestrationDecisions.workspaceId,
    decisionId: orchestrationDecisions.decisionId,
    fingerprint: orchestrationDecisions.fingerprint,
    candidatePolicyVersion: orchestrationDecisions.candidatePolicyVersion,
    model: orchestrationDecisions.model,
    experimentArm: orchestrationDecisions.experimentArm,
    propensity: orchestrationDecisions.propensity,
    applied: orchestrationDecisions.applied,
    effective: orchestrationDecisions.effective,
    suggested: orchestrationDecisions.suggested,
    status: orchestrationDecisions.status,
    reason: orchestrationDecisions.reason,
    createdAt: orchestrationDecisions.createdAt,
  }).from(orchestrationDecisions).where(claimDecisionsWhere(opts)).limit(CLAIM_HOLD_READOUT_MAX_DECISIONS)) as ClaimDecisionForReadout[];

  const empty: ClaimHoldReadoutInput = { decisions, labels: [], tasks: [], starts: [], windowEnd: opts.until };
  const taskIds = [...new Set(decisions.map(d => d.taskId).filter((t): t is string => !!t))];
  if (decisions.length === 0 || taskIds.length === 0) return empty;

  const { loadOrchestrationOutcomeInput } = await import('./orchestration-ledger-source');
  const [outcomeInput, startRows] = await Promise.all([
    loadOrchestrationOutcomeInput({ ...opts, decisionId: CLAIM_HOLD_DECISION.id }),
    db.select({ taskId: workers.taskId, createdAt: workers.createdAt })
      .from(workers)
      .where(claimStartsWhere({ workspaceId: opts.workspaceId, taskIds, since: opts.since })),
  ]);
  return {
    decisions,
    labels: labelDecisionOutcomes(outcomeInput),
    tasks: outcomeInput.tasks.map(t => ({ id: t.id, status: t.status })),
    starts: (startRows as Array<{ taskId: string | null; createdAt: Date }>)
      .filter((r): r is { taskId: string; createdAt: Date } => !!r.taskId)
      .map((r): TaskStartForReadout => ({ taskId: r.taskId, startedAt: r.createdAt })),
    windowEnd: opts.until,
  };
}

export const SOFT_START_REASON = 'soft_overlap_start';

export function softStartEventsWhere(opts: { workspaceId: string; since: Date; until: Date }) {
  return and(
    eq(gateEvents.workspaceId, opts.workspaceId),
    eq(gateEvents.gate, GATE_SLUGS.CLAIM_LOOP_DEFERRAL),
    eq(gateEvents.outcome, 'accepted'),
    eq(gateEvents.reason, SOFT_START_REASON),
    gte(gateEvents.occurredAt, opts.since),
    lt(gateEvents.occurredAt, opts.until),
  );
}

export function siblingProbeEventsWhere(opts: { workspaceId: string; since: Date; until: Date }) {
  return and(
    eq(gateEvents.workspaceId, opts.workspaceId),
    eq(gateEvents.gate, GATE_SLUGS.SIBLING_CONFLICT_PROBE),
    gte(gateEvents.occurredAt, opts.since),
    lt(gateEvents.occurredAt, opts.until),
  );
}

/**
 * Soft-overlap STARTs (rule or Jev) in a window, with the labeller's inputs for
 * the started tasks (the same join the Jev decisions use) and the sibling
 * probes of the same workspace, for `summarizeSoftStartReadout`.
 */
export async function loadSoftStartReadoutInput(opts: { workspaceId: string; since: Date; until: Date }): Promise<SoftStartReadoutInput> {
  const rows = await db.select({
    id: gateEvents.id,
    taskId: gateEvents.taskId,
    workspaceId: gateEvents.workspaceId,
    occurredAt: gateEvents.occurredAt,
    detail: gateEvents.detail,
  }).from(gateEvents).where(softStartEventsWhere(opts)).limit(CLAIM_HOLD_READOUT_MAX_DECISIONS);
  const starts: SoftStartForReadout[] = (rows as Array<{ id: string; taskId: string | null; workspaceId: string | null; occurredAt: Date; detail: Record<string, unknown> | null }>)
    .flatMap((r) => {
      if (!r.taskId || !r.workspaceId) return [];
      const d = r.detail ?? {};
      return [{
        id: r.id,
        taskId: r.taskId,
        workspaceId: r.workspaceId,
        holderTaskId: typeof d.holderTaskId === 'string' ? d.holderTaskId : null,
        decidedBy: d.decidedBy === 'jev' ? 'jev' as const : 'rule' as const,
        riskTier: typeof d.riskTier === 'string' ? d.riskTier : null,
        startedAt: r.occurredAt,
      }];
    });
  const empty = { tasks: [], labels: [], prs: [], conflictTasks: [], gateEvents: [] };
  if (starts.length === 0) return { starts, outcome: empty, probes: [], windowEnd: opts.until };
  const { loadOutcomeJoinFor } = await import('./orchestration-ledger-source');
  const [join, probeRows] = await Promise.all([
    loadOutcomeJoinFor(starts.map(s => ({
      id: s.id, taskId: s.taskId, workspaceId: s.workspaceId, prNumber: null, headSha: null, baseRef: null, createdAt: s.startedAt,
    })), opts),
    db.select({ workspaceId: gateEvents.workspaceId, taskId: gateEvents.taskId, occurredAt: gateEvents.occurredAt, detail: gateEvents.detail })
      .from(gateEvents).where(siblingProbeEventsWhere({ workspaceId: opts.workspaceId, since: opts.since, until: new Date() })),
  ]);
  const { decisions: _decisions, ...outcome } = join;
  return { starts, outcome, probes: probeRows as SiblingProbeEventForReadout[], windowEnd: opts.until };
}
