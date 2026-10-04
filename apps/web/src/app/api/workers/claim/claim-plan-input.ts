/**
 * Claim-route half of the batch planner (knowledge-base: buildd/design/jev-scheduling.md §5).
 *
 * `planClaimBatch` (packages/core/claim-planner.ts) is pure; this module turns
 * what the claim route already holds — the SQL-filtered candidates, the open-PR
 * prefetch, the active leases, the mission in-flight rows, the tasks claimed
 * so far in this batch — plus the planner signals loaded once per request
 * (./claim-plan-store) into its input. Nothing here does I/O or calls a model.
 *
 * Node ids: a candidate is its task id. In-flight rows are prefixed by kind
 * (`pr:`, `lease:`, `w:`) because one task can own several of them; every one
 * carries `taskId` so the planner never blocks a task on its own rows.
 *
 * Scope paths are prefixed with the workspace id: the planner has no workspace
 * concept, and two repos' `src/index.ts` are not the same file. The repo-wide
 * sentinel stays bare — the planner reads it as "undeclared", never as a path.
 */
import {
  CLAIM_PLANNER_CALIBRATION,
  overlapPairKey,
  type ClaimPlanInput,
  type OverlapAnswer,
  type PlannerCandidate,
  type PlannerInFlight,
  type PlannerPressure,
  type PlannerThresholds,
} from '@buildd/core/claim-planner';
import { findStackedPrs, REPO_WIDE_SENTINEL } from '@buildd/core/path-overlap';

export type ClaimPlannerMode = 'off' | 'record' | 'apply';

export interface ClaimPlannerConfig {
  mode: ClaimPlannerMode;
  thresholds: PlannerThresholds | null;
}

const isUnit = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;

/**
 * The workspace's planner mode and thresholds. An unrecognised mode is `off`;
 * absent or malformed thresholds fall back to the pinned calibration.
 */
export function resolveClaimPlannerConfig(gitConfig: unknown): ClaimPlannerConfig {
  const g = (gitConfig && typeof gitConfig === 'object' ? gitConfig : {}) as Record<string, unknown>;
  const mode: ClaimPlannerMode = g.claimPlanner === 'record' || g.claimPlanner === 'apply' ? g.claimPlanner : 'off';
  const t = g.claimPlannerThresholds as Record<string, unknown> | null | undefined;
  const thresholds = t && isUnit(t.thetaOrder) && isUnit(t.thetaSoft) && isUnit(t.thetaIdle)
    ? { thetaOrder: t.thetaOrder, thetaSoft: t.thetaSoft, thetaIdle: t.thetaIdle }
    : CLAIM_PLANNER_CALIBRATION.thresholds;
  return { mode, thresholds };
}

/** The open-PR prefetch row the claim route builds per workspace. */
export interface OpenPrEntry {
  taskId: string | null;
  pathManifest: string[] | null;
  prNumber: number | null;
  prUrl: string | null;
  branch: string | null;
  prBaseRef: string | null;
}

/**
 * Split a workspace's open PRs into the ones that can block `task` and the ones
 * it is exempt from: a PR its own earlier worker opened, the PR a fix attempt
 * (conflict / review / CI) exists to fix, the PR its subject anchor names, and
 * any PR stacked on one of those. Shared by the claim loop's layer-1 backstop
 * and the planner input so the two can never disagree about an exemption.
 */
export function splitOwnOpenPrs<T extends OpenPrEntry>(task: any, openPrTasks: T[]): { others: T[]; own: T[] } {
  const ownRetryPrNumber = (task.conflictRetryPrNumber
    ?? task.reviewerRetryPrNumber
    ?? task.ciRetryPrNumber) as number | null | undefined;
  const ownSubjectPrNumber = task.subjectKind === 'pull_request'
    ? (task.subjectPrNumber as number | null | undefined)
    : null;
  const isOwnPr = (pr: T) =>
    pr.taskId === task.id
    || (!!ownRetryPrNumber && pr.prNumber === ownRetryPrNumber)
    || (!!ownSubjectPrNumber && pr.prNumber === ownSubjectPrNumber);
  const ownPrs = openPrTasks.filter(isOwnPr);
  const stackedOnOwn = findStackedPrs(ownPrs.map(pr => pr.branch).filter((b): b is string => !!b), openPrTasks);
  const own: T[] = [];
  const others: T[] = [];
  for (const pr of openPrTasks) (isOwnPr(pr) || stackedOnOwn.has(pr) ? own : others).push(pr);
  return { others, own };
}

/** The latest creation-time prediction for one task. */
export interface PlannerPrediction {
  selected: string[];
  setConfidence: number | null;
  expectedSize: { files: number; minutes: number } | null;
  unknownScope: boolean;
}

/** A stored Jev overlap answer, by task pair. */
export interface StoredOverlapAnswer {
  taskAId: string;
  taskBId: string;
  answer: OverlapAnswer;
}

/** Everything the planner needs that the route does not already hold. One load per request. */
export interface PlannerSignals {
  predictions: Map<string, PlannerPrediction>;
  overlapAnswers: StoredOverlapAnswer[];
  /** Distinct `ordered_behind` records per task — one per (task, blocker) pair. */
  starvationCredit: Map<string, number>;
  /** Non-cancelled tasks that declare each candidate in their dependsOn. */
  dependentCount: Map<string, number>;
}

export const EMPTY_PLANNER_SIGNALS: PlannerSignals = {
  predictions: new Map(),
  overlapAnswers: [],
  starvationCredit: new Map(),
  dependentCount: new Map(),
};

/** A mission in-flight row as the claim route reads it. */
export interface MissionInFlightRow {
  missionId: string | null;
  taskId: string | null;
  pathManifest: unknown;
  category: string | null;
  outputRequirement: unknown;
  context?: unknown;
}

export interface ClaimPlanSource {
  candidates: any[];
  openPrTasksByWorkspace: Map<string, OpenPrEntry[]>;
  activePathClaimsByWorkspace: Map<string, Map<string, string[]>>;
  missionInFlightRows: MissionInFlightRow[];
  /** Tasks claimed earlier in this batch: in flight from here on. */
  claimedThisBatch: any[];
  capacity: number;
  pressure: PlannerPressure | null;
  thresholds: PlannerThresholds | null;
  signals: PlannerSignals;
}

/** What the route needs to act on a plan beyond the planner's own output. */
export interface ClaimPlanContext {
  input: ClaimPlanInput;
  /** In-flight node id → the task that owns it, its kind and its raw (unprefixed) paths. */
  inFlightMeta: Map<string, { taskId: string | null; kind: PlannerInFlight['kind']; workspaceId: string; paths: string[] }>;
}

/** Same rule as the claim route's own: not a code change, so no files to collide on. */
export function producesNoFileEdits(outputRequirement: unknown): boolean {
  return outputRequirement === 'artifact_required' || outputRequirement === 'none';
}

function prefixed(workspaceId: string, paths: readonly string[] | null | undefined): string[] | null {
  if (!paths || paths.length === 0) return null;
  return paths.map(p => (p === REPO_WIDE_SENTINEL ? p : `${workspaceId}/${p}`));
}

function concreteOf(paths: unknown): string[] {
  return Array.isArray(paths) ? (paths as unknown[]).filter((p): p is string => typeof p === 'string' && p !== REPO_WIDE_SENTINEL) : [];
}

function manifestOf(task: any): string[] | null {
  return Array.isArray(task?.pathManifest) ? (task.pathManifest as string[]) : null;
}

function editsFiles(task: { category?: unknown; outputRequirement?: unknown }): boolean {
  return task.category !== 'review' && !producesNoFileEdits(task.outputRequirement);
}

/** A prediction's scope, unless it marked itself unknown or selected nothing. */
function predictedScopeOf(workspaceId: string, p: PlannerPrediction | undefined): string[] | null {
  if (!p || p.unknownScope || p.selected.length === 0) return null;
  return prefixed(workspaceId, p.selected);
}

export function buildClaimPlanInput(src: ClaimPlanSource): ClaimPlanContext {
  const inFlight: PlannerInFlight[] = [];
  const inFlightMeta: ClaimPlanContext['inFlightMeta'] = new Map();
  const addInFlight = (node: PlannerInFlight, workspaceId: string, paths: string[]) => {
    if (inFlightMeta.has(node.id)) return;
    inFlight.push(node);
    inFlightMeta.set(node.id, { taskId: node.taskId ?? null, kind: node.kind, workspaceId, paths });
  };
  const workspaceIds = new Set(src.candidates.map(c => c.workspaceId as string));

  // Open PRs: their declared files are pinned whether or not anything runs.
  const prNodeId = (e: OpenPrEntry) => `pr:${e.prUrl ?? e.prNumber ?? e.taskId}`;
  for (const wsId of workspaceIds) {
    for (const e of src.openPrTasksByWorkspace.get(wsId) ?? []) {
      const concrete = concreteOf(e.pathManifest);
      if (concrete.length === 0) continue;
      addInFlight(
        { id: prNodeId(e), kind: 'open_pr', taskId: e.taskId, missionId: null, declaredScope: prefixed(wsId, concrete) },
        wsId,
        concrete,
      );
    }
  }

  // Live leases: the files a running worker holds (declared or observed).
  for (const wsId of workspaceIds) {
    for (const [holder, paths] of src.activePathClaimsByWorkspace.get(wsId) ?? []) {
      const concrete = concreteOf(paths);
      if (concrete.length === 0) continue;
      addInFlight(
        { id: `lease:${holder}`, kind: 'lease', taskId: holder, missionId: null, declaredScope: prefixed(wsId, concrete) },
        wsId,
        concrete,
      );
    }
  }

  // In-flight scope-undeclared mission work: what the one-per-mission mutex
  // holds against. Concrete in-flight scope is covered by its leases above.
  for (const row of src.missionInFlightRows) {
    if (!row.missionId || !row.taskId) continue;
    if (!editsFiles(row)) continue;
    if (concreteOf(row.pathManifest).length > 0) continue;
    addInFlight({ id: `w:${row.taskId}`, kind: 'worker', taskId: row.taskId, missionId: row.missionId, declaredScope: null }, '', []);
  }

  // Claimed earlier in this batch: in flight now, with the scope they were planned with.
  for (const t of src.claimedThisBatch) {
    const ws = t.workspaceId as string;
    const manifest = manifestOf(t);
    const prediction = src.signals.predictions.get(t.id);
    const concrete = concreteOf(manifest);
    if (!editsFiles(t) && concrete.length === 0) continue;
    addInFlight(
      {
        id: `w:${t.id}`,
        kind: 'worker',
        taskId: t.id,
        missionId: t.missionId ?? null,
        declaredScope: prefixed(ws, manifest),
        predictedScope: predictedScopeOf(ws, prediction),
        setConfidence: prediction?.setConfidence ?? null,
      },
      ws,
      concrete,
    );
  }

  const candidates: PlannerCandidate[] = src.candidates.map((t): PlannerCandidate => {
    const ws = t.workspaceId as string;
    const prediction = src.signals.predictions.get(t.id);
    const openPrs = src.openPrTasksByWorkspace.get(ws) ?? [];
    const { own } = splitOwnOpenPrs(t, openPrs);
    const exemptFrom = own.map(prNodeId);
    return {
      id: t.id,
      priority: t.priority ?? 0,
      createdAt: t.createdAt ?? 0,
      missionId: t.missionId ?? null,
      declaredScope: prefixed(ws, manifestOf(t)),
      predictedScope: predictedScopeOf(ws, prediction),
      setConfidence: prediction?.setConfidence ?? null,
      expectedSize: prediction?.expectedSize ?? null,
      dependentCount: src.signals.dependentCount.get(t.id) ?? 0,
      starvationCredit: src.signals.starvationCredit.get(t.id) ?? 0,
      hasOpenPr: openPrs.some(pr => pr.taskId === t.id),
      editsFiles: editsFiles(t),
      ...(exemptFrom.length > 0 ? { exemptFrom } : {}),
    };
  });

  // Stored answers are per task pair; the planner keys them by node id, so an
  // answer about a task also covers every in-flight row that task owns.
  const overlapAnswers: Record<string, OverlapAnswer> = {};
  const nodesOf = new Map<string, string[]>();
  for (const c of candidates) nodesOf.set(c.id, [c.id]);
  for (const n of inFlight) {
    if (!n.taskId) continue;
    nodesOf.set(n.taskId, [...(nodesOf.get(n.taskId) ?? []), n.id]);
  }
  for (const a of src.signals.overlapAnswers) {
    for (const x of nodesOf.get(a.taskAId) ?? []) {
      for (const y of nodesOf.get(a.taskBId) ?? []) {
        if (x !== y) overlapAnswers[overlapPairKey(x, y)] = a.answer;
      }
    }
  }

  return {
    input: {
      candidates,
      inFlight,
      capacity: src.capacity,
      pressure: src.pressure,
      thresholds: src.thresholds,
      overlapAnswers,
    },
    inFlightMeta,
  };
}

/**
 * Candidates whose predicted scope the planner treats as real scope: a usable
 * prediction (not unknown, non-empty) at or above thetaOrder, with no concrete
 * declared scope of their own. For these — and only these — the claim loop's
 * per-mission advisory_manifest mutex is replaced by the planner's edges.
 */
export function plannerScopedTaskIds(ctx: ClaimPlanContext): Set<string> {
  const out = new Set<string>();
  const t = ctx.input.thresholds;
  if (!t) return out;
  for (const c of ctx.input.candidates) {
    const concrete = concreteOf(c.declaredScope);
    if (concrete.length > 0 && !(c.declaredScope ?? []).includes(REPO_WIDE_SENTINEL)) continue;
    const usable = (c.predictedScope ?? []).filter(p => p !== REPO_WIDE_SENTINEL);
    if (usable.length > 0 && c.setConfidence != null && c.setConfidence >= t.thetaOrder) out.add(c.id);
  }
  return out;
}
