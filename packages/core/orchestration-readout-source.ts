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
import { orchestrationDecisions, orchestrationManifestPredictions, tasks, workers } from './db/schema';
import type { ClaimReadoutRow, ManifestReadoutPrediction, RecordedPick } from './orchestration-readout';
import type { ClaimHoldReadoutInput } from './orchestration-claim-readout';

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
