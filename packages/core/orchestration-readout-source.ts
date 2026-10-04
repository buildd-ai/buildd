/**
 * The stores half of the orchestration readout (./orchestration-readout.ts).
 *
 * Loads, for one workspace and window, everything the readout grades:
 *  - §5b: claim decision rows (with confidence, latency, cost) plus H's
 *    `loadClaimHoldReadoutInput` (F's outcome labels, task statuses, starts);
 *  - §5a: G's prediction rows and `loadManifestPredictionLabels`, joined to the
 *    per-pick ledger rows for model, arm, latency and cost;
 *  - work-unit links per task: its retry-chain root (parent walk), its PRs
 *    (worker PRs, conflict-retry PR, subject PR) and, optionally, its mission.
 *
 * Read-only, workspace-scoped throughout. Predicates are exported so tests
 * render them with the real dialect.
 */
import { and, eq, gte, inArray, isNotNull, lt } from 'drizzle-orm';
import { db } from './db/client';
import { gateEvents, orchestrationDecisions, orchestrationManifestPredictions, orchestrationTouchLabels, tasks, workers } from './db/schema';
import type { ClaimReadoutRow, ManifestReadoutPrediction, RecordedPick } from './orchestration-readout';
import type { ClaimHoldReadoutInput } from './orchestration-claim-readout';
import { GATE_SLUGS } from './gate-events';
import { pathsOverlap } from './path-overlap';
import { isoWeekStart, weekKey, type AgentBackend, type ClaimPlanSample, type WeeklySchedulingRawInput } from './scheduling-metrics';

export const READOUT_MAX_ROWS = 5_000;
/** Retry chains deeper than this are cut (the root found so far still links the chain). */
export const READOUT_MAX_CHAIN_DEPTH = 8;

export interface ReadoutWindow { workspaceId: string; since: Date; until: Date }

// ── Predicates ───────────────────────────────────────────────────────────────

export function claimReadoutRowsWhere(opts: ReadoutWindow) {
  return and(
    eq(orchestrationDecisions.workspaceId, opts.workspaceId),
    eq(orchestrationDecisions.capability, 'orchestration_claim'),
    gte(orchestrationDecisions.createdAt, opts.since),
    lt(orchestrationDecisions.createdAt, opts.until),
  );
}

export function manifestPickRowsWhere(opts: { workspaceId: string; taskIds: string[] }) {
  return and(
    eq(orchestrationDecisions.workspaceId, opts.workspaceId),
    eq(orchestrationDecisions.capability, 'orchestration_manifest'),
    inArray(orchestrationDecisions.taskId, opts.taskIds),
  );
}

export function readoutPredictionsWhere(opts: ReadoutWindow) {
  return and(
    eq(orchestrationManifestPredictions.workspaceId, opts.workspaceId),
    gte(orchestrationManifestPredictions.createdAt, opts.since),
    lt(orchestrationManifestPredictions.createdAt, opts.until),
  );
}

export function linkTasksWhere(opts: { workspaceId: string; taskIds: string[] }) {
  return and(eq(tasks.workspaceId, opts.workspaceId), inArray(tasks.id, opts.taskIds));
}

export function linkWorkersWhere(opts: { workspaceId: string; taskIds: string[] }) {
  return and(eq(workers.workspaceId, opts.workspaceId), inArray(workers.taskId, opts.taskIds), isNotNull(workers.prNumber));
}

// ── Links (pure) ─────────────────────────────────────────────────────────────

export interface LinkTaskRow {
  id: string;
  parentTaskId: string | null;
  missionId: string | null;
  conflictRetryPrNumber: number | null;
  subjectPrNumber: number | null;
}

/**
 * Link keys per task. `chain:` is the topmost known ancestor, so a retry and
 * the task it retries share one key; `pr:` joins every task touching a PR
 * (its own, the one it repairs, the one it reviews).
 */
export function taskLinkKeys(input: {
  taskIds: readonly string[];
  tasks: readonly LinkTaskRow[];
  prs: ReadonlyArray<{ taskId: string; prNumber: number }>;
  linkMissions: boolean;
}): Map<string, string[]> {
  const byId = new Map(input.tasks.map(t => [t.id, t]));
  const out = new Map<string, string[]>();
  for (const id of input.taskIds) {
    let root = id;
    const seen = new Set<string>([id]);
    for (let d = 0; d < READOUT_MAX_CHAIN_DEPTH; d++) {
      const parent = byId.get(root)?.parentTaskId;
      if (!parent || seen.has(parent)) break;
      seen.add(parent);
      root = parent;
    }
    const t = byId.get(id);
    const keys = new Set<string>([`chain:${root}`]);
    for (const p of input.prs) if (p.taskId === id) keys.add(`pr:${p.prNumber}`);
    if (t?.conflictRetryPrNumber) keys.add(`pr:${t.conflictRetryPrNumber}`);
    if (t?.subjectPrNumber) keys.add(`pr:${t.subjectPrNumber}`);
    if (input.linkMissions && t?.missionId) keys.add(`mission:${t.missionId}`);
    out.set(id, [...keys].sort());
  }
  return out;
}

async function loadTaskLinks(workspaceId: string, taskIds: string[], linkMissions: boolean): Promise<Map<string, string[]>> {
  if (taskIds.length === 0) return new Map();
  const rows: LinkTaskRow[] = [];
  let frontier = [...new Set(taskIds)];
  const loaded = new Set<string>();
  for (let d = 0; d <= READOUT_MAX_CHAIN_DEPTH && frontier.length > 0; d++) {
    const batch = (await db.select({
      id: tasks.id,
      parentTaskId: tasks.parentTaskId,
      missionId: tasks.missionId,
      conflictRetryPrNumber: tasks.conflictRetryPrNumber,
      subjectPrNumber: tasks.subjectPrNumber,
    }).from(tasks).where(linkTasksWhere({ workspaceId, taskIds: frontier }))) as LinkTaskRow[];
    for (const r of batch) { rows.push(r); loaded.add(r.id); }
    frontier = [...new Set(batch.map(r => r.parentTaskId).filter((p): p is string => !!p && !loaded.has(p)))];
  }
  const prs = (await db.select({ taskId: workers.taskId, prNumber: workers.prNumber }).from(workers)
    .where(linkWorkersWhere({ workspaceId, taskIds }))) as Array<{ taskId: string | null; prNumber: number | null }>;
  return taskLinkKeys({
    taskIds,
    tasks: rows,
    prs: prs.filter((p): p is { taskId: string; prNumber: number } => !!p.taskId && typeof p.prNumber === 'number'),
    linkMissions,
  });
}

// ── Loaders ──────────────────────────────────────────────────────────────────

export async function loadClaimReadoutInput(opts: ReadoutWindow & { linkMissions?: boolean }): Promise<{
  rows: ClaimReadoutRow[];
  hold: ClaimHoldReadoutInput;
  links: Map<string, string[]>;
}> {
  const rows = (await db.select({
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
    confidence: orchestrationDecisions.confidence,
    latencyMs: orchestrationDecisions.latencyMs,
    costUsd: orchestrationDecisions.costUsd,
    createdAt: orchestrationDecisions.createdAt,
  }).from(orchestrationDecisions).where(claimReadoutRowsWhere(opts)).limit(READOUT_MAX_ROWS)) as ClaimReadoutRow[];
  const { loadClaimHoldReadoutInput } = await import('./orchestration-claim-source');
  const hold = await loadClaimHoldReadoutInput(opts);
  const taskIds = [...new Set(rows.map(r => r.taskId).filter((t): t is string => !!t))];
  return { rows, hold, links: await loadTaskLinks(opts.workspaceId, taskIds, opts.linkMissions ?? true) };
}

export async function loadManifestReadoutInput(opts: ReadoutWindow & { linkMissions?: boolean }): Promise<{
  predictions: ManifestReadoutPrediction[];
  links: Map<string, string[]>;
}> {
  const preds = await db.select({
    id: orchestrationManifestPredictions.id,
    taskId: orchestrationManifestPredictions.taskId,
    createdAt: orchestrationManifestPredictions.createdAt,
    decisionId: orchestrationManifestPredictions.decisionId,
    candidatePolicyVersion: orchestrationManifestPredictions.candidatePolicyVersion,
    candidates: orchestrationManifestPredictions.candidates,
    picks: orchestrationManifestPredictions.picks,
    selected: orchestrationManifestPredictions.selected,
    unknownScope: orchestrationManifestPredictions.unknownScope,
    regexPaths: orchestrationManifestPredictions.regexPaths,
    neighbourUnionPaths: orchestrationManifestPredictions.neighbourUnionPaths,
  }).from(orchestrationManifestPredictions).where(readoutPredictionsWhere(opts)).limit(READOUT_MAX_ROWS);
  if (preds.length === 0) return { predictions: [], links: new Map() };

  const taskIds = [...new Set(preds.map(p => p.taskId))];
  const { loadManifestPredictionLabels } = await import('./manifest-prediction-source');
  const [labels, pickRows, links] = await Promise.all([
    loadManifestPredictionLabels({ ...opts, limit: READOUT_MAX_ROWS }),
    db.select({
      taskId: orchestrationDecisions.taskId,
      step: orchestrationDecisions.step,
      model: orchestrationDecisions.model,
      experimentArm: orchestrationDecisions.experimentArm,
      latencyMs: orchestrationDecisions.latencyMs,
      costUsd: orchestrationDecisions.costUsd,
      createdAt: orchestrationDecisions.createdAt,
    }).from(orchestrationDecisions).where(manifestPickRowsWhere({ workspaceId: opts.workspaceId, taskIds })),
    loadTaskLinks(opts.workspaceId, taskIds, opts.linkMissions ?? true),
  ]);
  const labelOf = new Map(labels.map(l => [l.predictionId, l.label]));
  const stepsOf = new Map<string, ManifestReadoutPrediction['pickRows']>();
  for (const r of pickRows as Array<{ taskId: string | null; step: number; model: string | null; experimentArm: 'apply' | 'observe'; latencyMs: number; costUsd: number | null }>) {
    if (!r.taskId) continue;
    const list = stepsOf.get(r.taskId) ?? [];
    // One prediction per task per candidate policy: the first row per step wins.
    if (!list[r.step]) list[r.step] = { model: r.model, experimentArm: r.experimentArm, latencyMs: r.latencyMs, costUsd: r.costUsd };
    stepsOf.set(r.taskId, list);
  }

  const predictions: ManifestReadoutPrediction[] = preds.map(p => ({
    predictionId: p.id,
    taskId: p.taskId,
    createdAt: p.createdAt,
    decisionId: p.decisionId,
    candidatePolicyVersion: p.candidatePolicyVersion,
    candidates: p.candidates ?? [],
    picks: ((p.picks ?? []) as unknown as RecordedPick[]).map(k => ({
      step: k.step,
      offered: Array.isArray(k.offered) ? k.offered : [],
      suggested: k.suggested ?? null,
      confidence: typeof k.confidence === 'number' ? k.confidence : null,
      fingerprint: k.fingerprint,
      status: k.status,
    })),
    selected: p.selected ?? [],
    unknownScope: p.unknownScope,
    regexPaths: p.regexPaths ?? [],
    neighbourUnionPaths: p.neighbourUnionPaths ?? [],
    label: labelOf.get(p.id) ?? { status: 'missing', reason: 'no_terminal_observation' },
    pickRows: stepsOf.get(p.taskId) ?? [],
  }));
  return { predictions, links };
}

// ── §6 scheduling metrics (knowledge-base: buildd/design/jev-scheduling.md §6) ─
//
// Loads and groups, by ISO week, everything ./scheduling-metrics.ts needs:
// claim-loop deferrals and the claim planner's own `claim_plan` ledger rows
// (both written by the claim route, see apps/web/.../claim/route.ts and
// ./claim-plan-store.ts — mirrored here as plain strings since packages/core
// cannot import the web app), silent-completion and supersession gate rows,
// claimed/conflict task counts, PR merge latency, and sampled co-running
// worker pairs for the unsafe co-schedule guardrail. Grouping and bucketing
// happen here; ./scheduling-metrics.ts only does rate/percentile math on the
// result.
export const SCHEDULING_METRICS_MAX_ROWS = 20_000;
/** Bounds the O(n²) co-running pairwise scan below. */
const CO_SCHEDULE_MAX_WORKERS = 500;

/** Mirrors `apps/web/src/app/api/workers/claim/claim-plan-store.ts`'s `CLAIM_PLAN_REASON`. */
const CLAIM_PLAN_REASON = 'claim_plan';
/** Mirrors the three primary reason keys in the claim route's own `deferrals` counter object. */
const PRIMARY_DEFERRAL_REASONS = ['path_overlap', 'advisory_manifest', 'ordered_behind'] as const;
const CODEX_SINGLE_FLIGHT_REASON = 'codex_single_flight';

function emptySchedulingWeek(
  workspaceId: string,
  weekStart: Date,
  mode: WeeklySchedulingRawInput['mode'],
): WeeklySchedulingRawInput {
  return {
    workspaceId,
    weekStart,
    mode,
    deferrals: { path_overlap: 0, advisory_manifest: 0, ordered_behind: 0, codex_single_flight: 0 },
    claimedTaskCount: 0,
    strandedCount: 0,
    mergeLatenciesMs: [],
    conflictTaskCount: 0,
    mergedPrCount: 0,
    unsafeCoScheduleCount: 0,
    coScheduleSampleCount: 0,
    silentCompletionCount: 0,
    supersessionCancelCount: 0,
    supersessionRevertedCount: 0,
    claimPlans: [],
    plannerWouldBePickLabels: [],
  };
}

export async function loadSchedulingMetricsInput(opts: ReadoutWindow): Promise<WeeklySchedulingRawInput[]> {
  const { workspaceId, since, until } = opts;
  const byWeek = new Map<string, WeeklySchedulingRawInput>();
  const bucket = (d: Date): WeeklySchedulingRawInput => {
    const key = weekKey(d);
    let w = byWeek.get(key);
    if (!w) {
      w = emptySchedulingWeek(workspaceId, isoWeekStart(d), 'off');
      byWeek.set(key, w);
    }
    return w;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const inWindow = (col: any) => and(gte(col, since), lt(col, until));

  // 1. claim_loop_deferral: the three primary reasons + codex_single_flight
  // (outcome=deferred), and stranding (outcome=stranded, any reason).
  const deferralRows = await db.select({
    occurredAt: gateEvents.occurredAt,
    outcome: gateEvents.outcome,
    reason: gateEvents.reason,
  }).from(gateEvents).where(and(
    eq(gateEvents.workspaceId, workspaceId),
    eq(gateEvents.gate, GATE_SLUGS.CLAIM_LOOP_DEFERRAL),
    inArray(gateEvents.outcome, ['deferred', 'stranded']),
    inWindow(gateEvents.occurredAt),
  )).limit(SCHEDULING_METRICS_MAX_ROWS);

  for (const r of deferralRows) {
    const w = bucket(r.occurredAt);
    if (r.outcome === 'stranded') { w.strandedCount++; continue; }
    if (r.reason === CODEX_SINGLE_FLIGHT_REASON) { w.deferrals.codex_single_flight++; continue; }
    if ((PRIMARY_DEFERRAL_REASONS as readonly string[]).includes(r.reason)) {
      w.deferrals[r.reason as (typeof PRIMARY_DEFERRAL_REASONS)[number]]++;
    }
  }

  // 2. claim_plan (record + apply), weighted by its coalesced repeat count —
  // recordOrCoalesceRepeat collapses identical (plan, picks) pairs within an
  // hour into one row whose detail.count climbs, so a quiet queue polled every
  // few seconds does not read as a single sample. `pickedCount` reads the
  // RULE'S actual picks (detail.actual), not the plan's own picks: record mode
  // never changes what really happened, so actual is what idle-capacity and
  // the primary metrics must be judged against in both modes; only the
  // divergence metric below reads the plan's own picks (via detail.agree).
  const planRows = await db.select({
    occurredAt: gateEvents.occurredAt,
    detail: gateEvents.detail,
  }).from(gateEvents).where(and(
    eq(gateEvents.workspaceId, workspaceId),
    eq(gateEvents.gate, GATE_SLUGS.CLAIM_LOOP_DEFERRAL),
    eq(gateEvents.reason, CLAIM_PLAN_REASON),
    eq(gateEvents.outcome, 'accepted'),
    inWindow(gateEvents.occurredAt),
  )).limit(SCHEDULING_METRICS_MAX_ROWS);

  for (const r of planRows) {
    const d = (r.detail ?? {}) as Record<string, unknown>;
    const mode: 'record' | 'apply' | null = d.mode === 'apply' ? 'apply' : d.mode === 'record' ? 'record' : null;
    if (!mode) continue;
    const backend: AgentBackend | 'mixed' = d.backend === 'codex' ? 'codex' : d.backend === 'mixed' ? 'mixed' : 'claude';
    const candidateCount = typeof d.candidateCount === 'number' ? d.candidateCount : 0;
    const pickedCount = Array.isArray(d.actual) ? d.actual.length : 0;
    const capacity = typeof d.capacity === 'number' ? d.capacity : null;
    const repeat = typeof d.count === 'number' && d.count > 0 ? d.count : 1;
    const sample: ClaimPlanSample = { mode, backend, agree: d.agree === true, candidateCount, pickedCount, capacity };
    const w = bucket(r.occurredAt);
    // A week with no deferral rows yet is still 'off'; the first plan sample
    // promotes it. A week that sees both modes keeps whichever was seen first
    // — a mid-week config change splitting one week's mode is out of scope.
    if (w.mode === 'off') w.mode = mode;
    for (let i = 0; i < repeat; i++) w.claimPlans.push(sample);
  }

  // 3. Silent completions (gate_events only; the design's §2 predicate itself
  // lives in apps/web/src/lib/silent-completion.ts and is not re-implemented here).
  const silentRows = await db.select({ occurredAt: gateEvents.occurredAt })
    .from(gateEvents).where(and(
      eq(gateEvents.workspaceId, workspaceId),
      eq(gateEvents.gate, GATE_SLUGS.SILENT_COMPLETION),
      eq(gateEvents.outcome, 'rejected'),
      inWindow(gateEvents.occurredAt),
    )).limit(SCHEDULING_METRICS_MAX_ROWS);
  for (const r of silentRows) bucket(r.occurredAt).silentCompletionCount++;

  // 4. Supersession cancels, and whether a human later un-cancelled the task.
  // The reconciler (apps/web/src/lib/supersession-store.ts) writes the
  // cancelled task's own id as the gate event's taskId, and nothing else ever
  // moves a task off `cancelled` automatically — so a current status other
  // than `cancelled` can only mean a person reopened it since.
  const supersessionRows = await db.select({ occurredAt: gateEvents.occurredAt, taskId: gateEvents.taskId })
    .from(gateEvents).where(and(
      eq(gateEvents.workspaceId, workspaceId),
      eq(gateEvents.gate, GATE_SLUGS.SUPERSESSION),
      eq(gateEvents.outcome, 'accepted'),
      inWindow(gateEvents.occurredAt),
    )).limit(SCHEDULING_METRICS_MAX_ROWS);
  const supersessionTaskIds = [...new Set(supersessionRows.map(r => r.taskId).filter((t): t is string => !!t))];
  const statusByTask = new Map<string, string>();
  if (supersessionTaskIds.length > 0) {
    const rows = await db.select({ id: tasks.id, status: tasks.status }).from(tasks).where(inArray(tasks.id, supersessionTaskIds));
    for (const r of rows) statusByTask.set(r.id, r.status);
  }
  for (const r of supersessionRows) {
    const w = bucket(r.occurredAt);
    w.supersessionCancelCount++;
    const status = r.taskId ? statusByTask.get(r.taskId) : undefined;
    if (status && status !== 'cancelled') w.supersessionRevertedCount++;
  }

  // 5. Claimed tasks per week (denominator for deferrals-per-claimed-task).
  const claimedRows = await db.select({ claimedAt: tasks.claimedAt }).from(tasks).where(and(
    eq(tasks.workspaceId, workspaceId),
    isNotNull(tasks.claimedAt),
    inWindow(tasks.claimedAt),
  )).limit(SCHEDULING_METRICS_MAX_ROWS);
  for (const r of claimedRows) if (r.claimedAt) bucket(r.claimedAt).claimedTaskCount++;

  // 6. Conflict tasks (creationSource = 'conflict'), bucketed by their own creation week.
  const conflictRows = await db.select({ createdAt: tasks.createdAt }).from(tasks).where(and(
    eq(tasks.workspaceId, workspaceId),
    eq(tasks.creationSource, 'conflict'),
    inWindow(tasks.createdAt),
  )).limit(SCHEDULING_METRICS_MAX_ROWS);
  for (const r of conflictRows) bucket(r.createdAt).conflictTaskCount++;

  // 7. Merged PRs and time-to-merge (created → merged), bucketed by merge week
  // — a merge is the moment the data point becomes available, and the moment
  // "conflict tasks per merged PR" is implicitly denominated against.
  const mergedRows = await db.select({
    mergedAt: workers.mergedAt,
    taskCreatedAt: tasks.createdAt,
  }).from(workers).innerJoin(tasks, eq(tasks.id, workers.taskId)).where(and(
    eq(workers.workspaceId, workspaceId),
    isNotNull(workers.mergedAt),
    inWindow(workers.mergedAt),
  )).limit(SCHEDULING_METRICS_MAX_ROWS);
  for (const r of mergedRows) {
    if (!r.mergedAt) continue;
    const w = bucket(r.mergedAt);
    w.mergedPrCount++;
    if (r.taskCreatedAt) w.mergeLatenciesMs.push(r.mergedAt.getTime() - r.taskCreatedAt.getTime());
  }

  // 8. Unsafe co-schedule: sample worker pairs in the same workspace whose
  // active windows overlapped, each with a terminal touch-label, and count
  // how many touched overlapping paths (reusing `pathsOverlap`, the same
  // predicate the claim planner itself uses — never a second overlap model).
  const coRunWorkers = await db.select({
    id: workers.id,
    startedAt: workers.startedAt,
    completedAt: workers.completedAt,
  }).from(workers).where(and(
    eq(workers.workspaceId, workspaceId),
    isNotNull(workers.startedAt),
    isNotNull(workers.completedAt),
    inWindow(workers.completedAt),
  )).limit(CO_SCHEDULE_MAX_WORKERS) as unknown as Array<{ id: string; startedAt: Date; completedAt: Date }>;

  if (coRunWorkers.length > 0) {
    const labelRows = await db.select({
      workerId: orchestrationTouchLabels.workerId,
      touchedPaths: orchestrationTouchLabels.touchedPaths,
    }).from(orchestrationTouchLabels).where(inArray(orchestrationTouchLabels.workerId, coRunWorkers.map(w => w.id)));
    const touchedByWorker = new Map(labelRows.filter((l): l is { workerId: string; touchedPaths: string[] } => !!l.workerId)
      .map(l => [l.workerId, l.touchedPaths ?? []]));

    const withLabels = coRunWorkers.filter(w => touchedByWorker.has(w.id));
    for (let i = 0; i < withLabels.length; i++) {
      for (let j = i + 1; j < withLabels.length; j++) {
        const a = withLabels[i];
        const b = withLabels[j];
        const overlapsInTime = a.startedAt.getTime() < b.completedAt.getTime() && b.startedAt.getTime() < a.completedAt.getTime();
        if (!overlapsInTime) continue;
        const pathsA = touchedByWorker.get(a.id) ?? [];
        const pathsB = touchedByWorker.get(b.id) ?? [];
        if (pathsA.length === 0 || pathsB.length === 0) continue;
        const sampledAt = new Date(Math.max(a.completedAt.getTime(), b.completedAt.getTime()));
        const w = bucket(sampledAt);
        w.coScheduleSampleCount++;
        if (pathsOverlap(pathsA, pathsB)) w.unsafeCoScheduleCount++;
      }
    }
  }

  return [...byWeek.values()];
}
