/**
 * Claim-time batch planner — the pure half of the scheduler's ordering step.
 *
 * Today the claim route walks candidates in `priority DESC, createdAt ASC` and
 * the first eligible task wins; overlap is only discovered by deferring that
 * task on every poll. `planClaimBatch` instead chooses a non-overlapping set
 * up to the capacity `k`, in the order it should be claimed, and names for
 * every node it skips which taken or in-flight node it is ordered behind.
 *
 * Pure and deterministic: no I/O, no clock, no randomness. The same input in
 * any row order produces the same plan, so the route can re-plan on every call
 * and nothing persists between calls to go stale.
 *
 * Graph:
 *  - **Hard edges** (never co-scheduled, never run against in-flight work):
 *    concrete-to-concrete `pathsOverlap`, overlap with a live lease, overlap
 *    with an open PR's pinned files, a shared serialized surface (e.g. the
 *    migration namespace), an unresolved `dependsOn`, and — for nodes with no
 *    usable scope at all — today's one-per-mission mutex.
 *  - **Soft edges**: any pair where at least one side's scope is predicted.
 *    Weight = max(setConfidence of the predicted sides) × overlapFraction,
 *    replaced by a stored overlap answer when one exists. Soft edges only ever
 *    delay; they never become hard.
 *
 * Score (lexicographic, so priority is never traded away): priority,
 * unblocking value, starvation credit (bucketed), smaller-first, createdAt,
 * id. Under pressure, smaller-first moves above unblocking.
 */

import { PARALLELISM_PRESSURE_FLOOR } from './oauth-budget';
import { hasConcretePathManifest, pathsOverlap, REPO_WIDE_SENTINEL, stripTrailingSep } from './path-overlap';

/**
 * Daily-budget share at or above which the planner treats the account as under
 * pressure. Mirrors `DAILY_CAP_DOWNGRADE_FRACTION` in apps/web/src/lib/ai/plan.ts
 * (the point a plan is served one tier cheaper) — core cannot import from the app.
 */
export const DAILY_BUDGET_DOWNGRADE_FRACTION = 0.8;

/** Claim calls per starvation bucket. One pass-over never reorders anything. */
export const STARVATION_BUCKET_WIDTH = 5;

// ── Input ────────────────────────────────────────────────────────────────────

export interface PlannerSize {
  /** Expected files changed. */
  files: number;
  /** Expected session minutes. */
  minutes: number;
}

interface PlannerScopeFields {
  missionId: string | null;
  /** Declared scope: a concrete manifest, or observed touches. */
  declaredScope: string[] | null;
  /** Predicted scope from the creation-time prediction. */
  predictedScope?: string[] | null;
  /** Confidence the predicted set is right, in [0, 1]. Null = unknown, never blocks. */
  setConfidence?: number | null;
  /** Serialized surfaces this node occupies (e.g. a migration namespace). */
  serializedSurfaces?: string[];
}

export interface PlannerCandidate extends PlannerScopeFields {
  id: string;
  priority: number;
  createdAt: number | string | Date;
  expectedSize: PlannerSize | null;
  /** Waiting tasks transitively behind this one, including dependents of its open PR. */
  dependentCount: number;
  /** Nodes already ordered behind this one by an earlier plan — the unblocking bonus. */
  orderedBehindCount?: number;
  /** Unresolved upstream task ids. Any entry makes this node unpickable this call. */
  dependsOn?: string[];
  /** Distinct claim calls that passed this node over since it became claimable. */
  starvationCredit?: number;
  /**
   * The task already has an open PR. Its declared files are pinned whether or
   * not the task is claimed now, so it is the blocker of any concrete overlap
   * with a candidate that has no PR ("PRs wait, agents do not").
   */
  hasOpenPr?: boolean;
  /**
   * False for work that never edits files (reviews, artifact/no-output tasks).
   * Such nodes are exempt from the no-scope mission mutex, as they are today.
   */
  editsFiles?: boolean;
  /**
   * In-flight ids this candidate never conflicts with: the open PR a fix
   * attempt or subject-anchored task exists to work on, and PRs stacked on it.
   * Same exemption the claim route's open-PR backstop applies.
   */
  exemptFrom?: string[];
}

export type PlannerInFlightKind = 'worker' | 'open_pr' | 'lease';

export interface PlannerInFlight extends PlannerScopeFields {
  id: string;
  kind: PlannerInFlightKind;
  /** The task this row belongs to; a candidate is never blocked by its own rows. */
  taskId?: string | null;
}

export interface PlannerPressure {
  /** Share of the daily budget spent, in [0, 1]. */
  dailyBudgetPct: number | null;
  /** Learned OAuth window pressure, in [0, 1]. */
  oauthPressure: number | null;
  confidence: 'none' | 'low' | 'good' | null;
}

export interface PlannerThresholds {
  /** Minimum setConfidence for a prediction to count as scope at all. */
  thetaOrder: number;
  /** Summed soft weight to the taken set must stay strictly below this. */
  thetaSoft: number;
  /** Work conservation: admitted when capacity would idle and weight is below this (≥ thetaSoft). */
  thetaIdle: number;
}

export type OverlapAnswer = 'REAL' | 'NOT_REAL';

export interface ClaimPlanInput {
  /** ≤100 rows that already passed the hard SQL filters. */
  candidates: PlannerCandidate[];
  inFlight: PlannerInFlight[];
  /** Capacity k. ≤ 0 plans nothing. */
  capacity: number;
  pressure: PlannerPressure | null;
  /** Null = declared/observed scope only: predictions are ignored entirely. */
  thresholds: PlannerThresholds | null;
  /** Stored overlap answers keyed by `overlapPairKey`. */
  overlapAnswers?: Record<string, OverlapAnswer>;
}

// ── Output ───────────────────────────────────────────────────────────────────

export type HardEdgeKind =
  | 'path_overlap'
  | 'lease_overlap'
  | 'open_pr_overlap'
  | 'serialized_surface'
  | 'depends_on'
  | 'no_scope_mutex';

export type EdgeKind = HardEdgeKind | 'soft_overlap';

/** Why a skipped node is ordered behind its blocker. */
export type OrientationReason = 'depends_on' | 'open_pr' | 'in_flight' | 'higher_score';

export interface PlannedPick {
  id: string;
  /** Claim order, 0-based. */
  order: number;
  admittedBy: 'greedy' | 'work_conservation';
  /** Summed soft weight to the taken and in-flight set when admitted. */
  softWeight: number;
}

export interface OrientationRecord {
  taskId: string;
  blockedBy: string;
  reason: OrientationReason;
  edge: EdgeKind;
}

export interface ScoreParts {
  priority: number;
  unblocking: number;
  starvationBucket: number;
  size: PlannerSize | null;
  createdAt: number;
}

export interface NodeExplanation {
  id: string;
  /** Position in score order, 0 = best. */
  rank: number;
  outcome: 'picked' | 'skipped';
  reason: 'greedy' | 'work_conservation' | EdgeKind | 'capacity';
  blockedBy: string | null;
  softWeight: number;
  score: ScoreParts;
}

export interface HardEdge {
  /** Always a candidate. */
  a: string;
  /** A candidate, an in-flight row, or an upstream id outside the batch. */
  b: string;
  kind: HardEdgeKind;
}

export interface ClaimPlan {
  picks: PlannedPick[];
  orientation: OrientationRecord[];
  explanations: NodeExplanation[];
  hardEdges: HardEdge[];
  underPressure: boolean;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Order-independent key for a stored overlap answer between two nodes. */
export function overlapPairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

export function starvationBucket(credit: number | null | undefined): number {
  if (!credit || credit < 0 || !Number.isFinite(credit)) return 0;
  return Math.floor(credit / STARVATION_BUCKET_WIDTH);
}

/**
 * Share of the smaller scope that `pathsOverlap` matches in the other, in [0, 1].
 * The repo-wide sentinel is dropped: it means "undeclared", not "everything".
 */
export function overlapFraction(a: string[], b: string[]): number {
  const na = a.filter(p => p !== REPO_WIDE_SENTINEL).map(stripTrailingSep);
  const nb = b.filter(p => p !== REPO_WIDE_SENTINEL).map(stripTrailingSep);
  if (na.length === 0 || nb.length === 0) return 0;
  const [small, other] = na.length <= nb.length ? [na, nb] : [nb, na];
  const matched = small.filter(p => pathsOverlap([p], other)).length;
  return matched / small.length;
}

export function isUnderPressure(p: PlannerPressure | null): boolean {
  if (!p) return false;
  const oauth = p.confidence === 'good' && p.oauthPressure != null && p.oauthPressure >= PARALLELISM_PRESSURE_FLOOR;
  const daily = p.dailyBudgetPct != null && p.dailyBudgetPct >= DAILY_BUDGET_DOWNGRADE_FRACTION;
  return oauth || daily;
}

function toMs(v: number | string | Date): number {
  if (typeof v === 'number') return v;
  const ms = v instanceof Date ? v.getTime() : Date.parse(v);
  return Number.isFinite(ms) ? ms : 0;
}

/** Scope as the planner reads it for one node. */
interface ResolvedScope {
  /** Concrete declared scope, or null. */
  concrete: string[] | null;
  /** Usable predicted scope (only when there is no concrete scope), or null. */
  predicted: string[] | null;
  confidence: number;
  /** No usable scope at all: today's mission mutex applies. */
  noScope: boolean;
}

function resolveScope(n: PlannerScopeFields, thresholds: PlannerThresholds | null): ResolvedScope {
  const concrete = hasConcretePathManifest(n.declaredScope)
    && !n.declaredScope!.includes(REPO_WIDE_SENTINEL)
    ? n.declaredScope!
    : null;
  let predicted: string[] | null = null;
  const confidence = n.setConfidence ?? 0;
  if (!concrete && thresholds && n.predictedScope && n.setConfidence != null && confidence >= thresholds.thetaOrder) {
    const usable = n.predictedScope.filter(p => p !== REPO_WIDE_SENTINEL);
    if (usable.length > 0) predicted = usable;
  }
  return { concrete, predicted, confidence, noScope: !concrete && !predicted };
}

interface Node {
  id: string;
  candidate: PlannerCandidate | null;
  inFlight: PlannerInFlight | null;
  scope: ResolvedScope;
  surfaces: Set<string>;
  missionId: string | null;
  editsFiles: boolean;
  hasOpenPr: boolean;
  ownerTaskId: string | null;
}

function compareSize(a: PlannerSize | null, b: PlannerSize | null): number {
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  return a.files - b.files || a.minutes - b.minutes;
}

function compareScores(x: ScoreParts & { id: string }, y: ScoreParts & { id: string }, pressure: boolean): number {
  const byPriority = y.priority - x.priority;
  const byUnblocking = y.unblocking - x.unblocking;
  const byStarvation = y.starvationBucket - x.starvationBucket;
  const bySize = compareSize(x.size, y.size);
  const tail = x.createdAt - y.createdAt || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0);
  return pressure
    ? byPriority || bySize || byUnblocking || byStarvation || tail
    : byPriority || byUnblocking || byStarvation || bySize || tail;
}

/** The hard edge between a candidate and another node, or null. Candidate-first. */
function hardEdgeBetween(c: Node, o: Node): HardEdgeKind | null {
  if (o.ownerTaskId === c.id) return null;
  if (o.inFlight && c.candidate?.exemptFrom?.includes(o.id)) return null;
  if (c.scope.concrete && o.scope.concrete && pathsOverlap(c.scope.concrete, o.scope.concrete)) {
    if (o.inFlight?.kind === 'lease') return 'lease_overlap';
    if (o.inFlight?.kind === 'open_pr') return 'open_pr_overlap';
    return 'path_overlap';
  }
  for (const s of c.surfaces) if (o.surfaces.has(s)) return 'serialized_surface';
  if (
    c.scope.noScope && o.scope.noScope && c.editsFiles && o.editsFiles
    && c.missionId != null && c.missionId === o.missionId
    && (o.candidate || o.inFlight?.kind === 'worker')
  ) {
    return 'no_scope_mutex';
  }
  return null;
}

function softWeightBetween(a: Node, b: Node, input: ClaimPlanInput): number {
  if (!input.thresholds) return 0;
  if (b.inFlight && (b.ownerTaskId === a.id || a.candidate?.exemptFrom?.includes(b.id))) return 0;
  if (!a.scope.predicted && !b.scope.predicted) return 0;
  const sa = a.scope.concrete ?? a.scope.predicted;
  const sb = b.scope.concrete ?? b.scope.predicted;
  if (!sa || !sb) return 0;
  const answer = input.overlapAnswers?.[overlapPairKey(a.id, b.id)];
  if (answer === 'REAL') return 1;
  if (answer === 'NOT_REAL') return 0;
  const conf = Math.max(a.scope.predicted ? a.scope.confidence : 0, b.scope.predicted ? b.scope.confidence : 0);
  return conf * overlapFraction(sa, sb);
}

// ── Planner ──────────────────────────────────────────────────────────────────

export function planClaimBatch(input: ClaimPlanInput): ClaimPlan {
  const underPressure = isUnderPressure(input.pressure);
  const k = Math.max(0, Math.floor(input.capacity));
  const thresholds = input.thresholds
    ? { ...input.thresholds, thetaIdle: Math.max(input.thresholds.thetaIdle, input.thresholds.thetaSoft) }
    : null;
  const effInput = { ...input, thresholds };

  const toNode = (n: PlannerCandidate | PlannerInFlight, isCandidate: boolean): Node => ({
    id: n.id,
    candidate: isCandidate ? (n as PlannerCandidate) : null,
    inFlight: isCandidate ? null : (n as PlannerInFlight),
    scope: resolveScope(n, thresholds),
    surfaces: new Set(n.serializedSurfaces ?? []),
    missionId: n.missionId,
    editsFiles: isCandidate ? (n as PlannerCandidate).editsFiles !== false : true,
    hasOpenPr: isCandidate ? !!(n as PlannerCandidate).hasOpenPr : (n as PlannerInFlight).kind === 'open_pr',
    ownerTaskId: isCandidate ? null : (n as PlannerInFlight).taskId ?? null,
  });

  const scoreOf = (c: PlannerCandidate): ScoreParts => ({
    priority: c.priority,
    unblocking: Math.max(0, c.dependentCount) + Math.max(0, c.orderedBehindCount ?? 0),
    starvationBucket: starvationBucket(c.starvationCredit),
    size: c.expectedSize,
    createdAt: toMs(c.createdAt),
  });

  const candidates = input.candidates
    .map(c => ({ node: toNode(c, true), score: scoreOf(c) }))
    .sort((x, y) => compareScores({ ...x.score, id: x.node.id }, { ...y.score, id: y.node.id }, underPressure));
  const rankOf = new Map(candidates.map((c, i) => [c.node.id, i]));
  const byId = new Map(candidates.map(c => [c.node.id, c.node]));
  const inFlight = [...input.inFlight].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map(f => toNode(f, false));

  // Hard edges, computed once. Candidate pairs are stored in both directions for lookup.
  const hardTo = new Map<string, Map<string, HardEdgeKind>>();
  const hardEdges: HardEdge[] = [];
  const addHard = (a: string, b: string, kind: HardEdgeKind) => {
    if (!hardTo.has(a)) hardTo.set(a, new Map());
    if (!hardTo.get(a)!.has(b)) hardTo.get(a)!.set(b, kind);
  };
  for (const { node: c } of candidates) {
    for (const up of [...new Set(c.candidate!.dependsOn ?? [])].sort()) {
      if (up === c.id) continue;
      addHard(c.id, up, 'depends_on');
      hardEdges.push({ a: c.id, b: up, kind: 'depends_on' });
    }
    for (const f of inFlight) {
      const kind = hardEdgeBetween(c, f);
      if (kind) {
        addHard(c.id, f.id, kind);
        hardEdges.push({ a: c.id, b: f.id, kind });
      }
    }
  }
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const a = candidates[i].node;
      const b = candidates[j].node;
      const kind = hardEdgeBetween(a, b);
      if (!kind) continue;
      if (!hardTo.get(a.id)?.has(b.id)) addHard(a.id, b.id, kind);
      if (!hardTo.get(b.id)?.has(a.id)) addHard(b.id, a.id, kind);
      const [x, y] = a.id < b.id ? [a.id, b.id] : [b.id, a.id];
      hardEdges.push({ a: x, b: y, kind });
    }
  }
  hardEdges.sort((x, y) => (x.a + '\0' + x.b + '\0' + x.kind < y.a + '\0' + y.b + '\0' + y.kind ? -1 : 1));

  const softCache = new Map<string, number>();
  const soft = (a: Node, b: Node): number => {
    const key = overlapPairKey(a.id, b.id);
    let w = softCache.get(key);
    if (w === undefined) {
      w = softWeightBetween(a, b, effInput);
      softCache.set(key, w);
    }
    return w;
  };

  const taken: Node[] = [];
  const takenIds = new Set<string>();
  const picks: PlannedPick[] = [];
  const skipped = new Map<string, { reason: EdgeKind | 'capacity'; blockedBy: string | null; orient: OrientationReason | null; softWeight: number }>();

  /** Blocker preference: dependency upstream, then open PR, then in-flight, then higher score. */
  const blockerRank = (n: Node | undefined, kind: EdgeKind): [number, number, string] => {
    if (kind === 'depends_on') return [0, 0, n?.id ?? ''];
    if (!n) return [4, 0, ''];
    if (n.hasOpenPr) return [1, rankOf.get(n.id) ?? -1, n.id];
    if (n.inFlight) return [2, 0, n.id];
    return [3, rankOf.get(n.id) ?? 0, n.id];
  };
  const orientReason = (n: Node | undefined, kind: EdgeKind): OrientationReason => {
    if (kind === 'depends_on') return 'depends_on';
    if (n?.hasOpenPr) return 'open_pr';
    if (n?.inFlight) return 'in_flight';
    return 'higher_score';
  };
  const lookup = (id: string): Node | undefined => byId.get(id) ?? inFlight.find(f => f.id === id);

  /** Hard blockers of c among taken, in-flight, open-PR-pinned candidates and dependency upstreams. */
  const hardBlockers = (c: Node): Array<{ id: string; kind: HardEdgeKind }> => {
    const out: Array<{ id: string; kind: HardEdgeKind }> = [];
    for (const [other, kind] of hardTo.get(c.id) ?? []) {
      const o = byId.get(other);
      const isPinnedPr = o && o.hasOpenPr && !c.hasOpenPr && kind === 'path_overlap';
      if (kind === 'depends_on' || !o || takenIds.has(other) || isPinnedPr) out.push({ id: other, kind });
    }
    return out;
  };

  const softSum = (c: Node): { total: number; top: Array<{ id: string; w: number }> } => {
    let total = 0;
    const top: Array<{ id: string; w: number }> = [];
    for (const o of [...inFlight, ...taken]) {
      const w = soft(c, o);
      if (w > 0) {
        total += w;
        top.push({ id: o.id, w });
      }
    }
    return { total, top };
  };

  const pickBlocker = (entries: Array<{ id: string; kind: EdgeKind }>) => {
    const ranked = entries
      .map(e => ({ ...e, node: lookup(e.id), r: blockerRank(lookup(e.id), e.kind) }))
      .sort((x, y) => x.r[0] - y.r[0] || x.r[1] - y.r[1] || (x.r[2] < y.r[2] ? -1 : x.r[2] > y.r[2] ? 1 : 0));
    const best = ranked[0];
    return { id: best.id, kind: best.kind, orient: orientReason(best.node, best.kind) };
  };

  // Greedy maximum-weight independent set by score. Continues past k so every
  // skipped node is classified by what actually holds it, not just "capacity".
  for (const { node: c } of candidates) {
    const hard = hardBlockers(c);
    if (hard.length > 0) {
      const b = pickBlocker(hard);
      skipped.set(c.id, { reason: b.kind, blockedBy: b.id, orient: b.orient, softWeight: softSum(c).total });
      continue;
    }
    const s = softSum(c);
    if (thresholds && s.total >= thresholds.thetaSoft) {
      const b = pickBlocker(s.top.filter(t => t.w === Math.max(...s.top.map(x => x.w))).map(t => ({ id: t.id, kind: 'soft_overlap' as const })));
      skipped.set(c.id, { reason: 'soft_overlap', blockedBy: b.id, orient: b.orient, softWeight: s.total });
      continue;
    }
    if (taken.length >= k) {
      skipped.set(c.id, { reason: 'capacity', blockedBy: null, orient: null, softWeight: s.total });
      continue;
    }
    taken.push(c);
    takenIds.add(c.id);
    picks.push({ id: c.id, order: picks.length, admittedBy: 'greedy', softWeight: s.total });
  }

  // Work conservation: capacity would idle and only soft edges stop the rest.
  if (thresholds) {
    while (taken.length < k) {
      let admitted: { node: Node; w: number } | null = null;
      for (const { node: c } of candidates) {
        const sk = skipped.get(c.id);
        if (!sk || sk.reason !== 'soft_overlap') continue;
        if (hardBlockers(c).length > 0) continue;
        const s = softSum(c);
        if (s.total < thresholds.thetaIdle) {
          admitted = { node: c, w: s.total };
          break;
        }
      }
      if (!admitted) break;
      const c = admitted.node;
      skipped.delete(c.id);
      taken.push(c);
      takenIds.add(c.id);
      picks.push({ id: c.id, order: picks.length, admittedBy: 'work_conservation', softWeight: admitted.w });
    }
  }

  const pickById = new Map(picks.map(p => [p.id, p]));
  const orientation: OrientationRecord[] = [];
  const explanations: NodeExplanation[] = candidates.map(({ node, score }, rank) => {
    const p = pickById.get(node.id);
    if (p) {
      return { id: node.id, rank, outcome: 'picked', reason: p.admittedBy, blockedBy: null, softWeight: p.softWeight, score };
    }
    const sk = skipped.get(node.id)!;
    if (sk.blockedBy && sk.orient) {
      orientation.push({ taskId: node.id, blockedBy: sk.blockedBy, reason: sk.orient, edge: sk.reason as EdgeKind });
    }
    return { id: node.id, rank, outcome: 'skipped', reason: sk.reason, blockedBy: sk.blockedBy, softWeight: sk.softWeight, score };
  });

  return { picks, orientation, explanations, hardEdges, underPressure };
}
