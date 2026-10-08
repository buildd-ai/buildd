/**
 * `explain` for a pending task held by coordination: who holds what, on which
 * paths, and why. Before this a task deferred on path overlap read "Nothing to
 * do; work resumes later" while its gate history said `path_overlap` with no
 * owner. The output keeps the shape the coordination UI needs: the edge kind,
 * the holder, the overlapping paths and the verdict.
 *
 * Edge kinds:
 *  - `declared_dependency`: a caller-supplied dependsOn edge (hard);
 *  - `inferred_dependency`: a dependsOn edge minted from a same-file,
 *    migration or serialized-surface overlap (hard);
 *  - `soft_overlap`: prefix-only overlap; never an edge, decided at claim by
 *    HOLD/START (verdict from the newest `soft_overlap` gate row);
 *  - `path_lease` / `open_pr`: the newest `path_overlap` deferral's holder.
 *
 * Pure: explain.ts loads the holders and the gate rows.
 */
import { isTerminalTaskStatus } from '@buildd/shared';
import { classifyManifestOverlap } from '@buildd/core/path-overlap';
import type { CausalLink, ExplainRefs } from '@/lib/explain-types';

export type CoordinationEdge = 'declared_dependency' | 'inferred_dependency' | 'soft_overlap' | 'path_lease' | 'open_pr';

export interface CoordinationHold {
  edge: CoordinationEdge;
  holderTaskId: string | null;
  holderTitle: string | null;
  holderStatus: string | null;
  prNumber: number | null;
  paths: string[];
  /** HOLD / START / deterministic_hold for a soft overlap; null when no decision applies. */
  verdict: string | null;
  overlapKind: string | null;
}

export interface CoordinationHolder {
  id: string;
  title: string | null;
  status: string;
  pathManifest: string[] | null;
}

export interface CoordinationGateDetail {
  holderTaskId?: string;
  blockingTaskId?: string;
  prNumber?: number;
  paths?: string[];
  verdict?: string;
  overlapKind?: string;
}

const OWNERSHIP_KEYS = ['holderTaskId', 'blockingTaskId', 'prNumber', 'paths', 'verdict', 'overlapKind'] as const;

/** The ownership subset of a gate row's detail, or null when it has none. */
export function coordinationGateDetail(detail: unknown): CoordinationGateDetail | null {
  if (!detail || typeof detail !== 'object') return null;
  const d = detail as Record<string, unknown>;
  const out: CoordinationGateDetail = {};
  for (const k of OWNERSHIP_KEYS) {
    const v = d[k];
    if (k === 'paths') {
      if (Array.isArray(v)) out.paths = v.filter((p): p is string => typeof p === 'string').slice(0, 10);
    } else if (k === 'prNumber') {
      if (typeof v === 'number' && Number.isFinite(v)) out.prNumber = v;
    } else if (typeof v === 'string' && v.length > 0) {
      (out as Record<string, string>)[k] = v;
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((p): p is string => typeof p === 'string') : []);

export function buildCoordinationHolds(input: {
  task: { status: string; dependsOn?: string[] | null; pathManifest?: string[] | null; pathDeclaration?: unknown };
  holders: ReadonlyMap<string, CoordinationHolder>;
  /** Gate rows for this task, newest first. */
  gateDetails: ReadonlyArray<{ reason: string; detail: unknown }>;
}): CoordinationHold[] {
  const { task, holders } = input;
  if (task.status !== 'pending') return [];
  const decl = (task.pathDeclaration ?? null) as Record<string, unknown> | null;
  const inferred = new Set(strings(decl?.inferredDependsOn));
  const holds: CoordinationHold[] = [];
  const base = (id: string | null) => {
    const h = id ? holders.get(id) : undefined;
    return { holderTaskId: id, holderTitle: h?.title ?? null, holderStatus: h?.status ?? null };
  };

  for (const id of task.dependsOn ?? []) {
    const h = holders.get(id);
    // A finished dependency only holds while its PR is unmerged; the dependency
    // gate decides that. Here: name every edge not yet terminal-and-cancelled.
    if (h && h.status === 'cancelled') continue;
    const overlap = inferred.has(id) ? classifyManifestOverlap(task.pathManifest ?? null, h?.pathManifest ?? null) : null;
    holds.push({
      edge: inferred.has(id) ? 'inferred_dependency' : 'declared_dependency',
      ...base(id),
      prNumber: null,
      paths: overlap?.paths ?? [],
      verdict: null,
      overlapKind: overlap && overlap.kind !== 'none' ? overlap.kind : null,
    });
  }

  const softRows = input.gateDetails
    .filter(g => g.reason === 'soft_overlap')
    .map(g => coordinationGateDetail(g.detail))
    .filter((d): d is CoordinationGateDetail => d !== null);
  const rawSoft = Array.isArray(decl?.softOverlaps) ? (decl!.softOverlaps as unknown[]) : [];
  for (const e of rawSoft) {
    const id = (e as { taskId?: unknown })?.taskId;
    if (typeof id !== 'string') continue;
    const h = holders.get(id);
    if (!h || isTerminalTaskStatus(h.status)) continue;
    const latest = softRows.find(d => d.holderTaskId === id);
    const overlap = classifyManifestOverlap(task.pathManifest ?? null, h.pathManifest);
    if (!latest && overlap.kind === 'none') continue;
    holds.push({
      edge: 'soft_overlap',
      ...base(id),
      prNumber: null,
      paths: latest?.paths?.length ? latest.paths : overlap.paths,
      verdict: latest?.verdict ?? null,
      overlapKind: latest?.overlapKind ?? (overlap.kind !== 'none' ? overlap.kind : null),
    });
  }

  const lastPath = input.gateDetails.find(g => g.reason === 'path_overlap');
  const pd = lastPath ? coordinationGateDetail(lastPath.detail) : null;
  if (pd?.blockingTaskId) {
    const h = holders.get(pd.blockingTaskId);
    if (!h || !isTerminalTaskStatus(h.status)) {
      const overlap = classifyManifestOverlap(task.pathManifest ?? null, h?.pathManifest ?? null);
      holds.push({
        edge: 'path_lease',
        ...base(pd.blockingTaskId),
        prNumber: null,
        paths: overlap.paths.length > 0 ? overlap.paths : (h?.pathManifest ?? []),
        verdict: null,
        overlapKind: null,
      });
    }
  } else if (pd?.prNumber) {
    holds.push({ edge: 'open_pr', holderTaskId: null, holderTitle: null, holderStatus: null, prNumber: pd.prNumber, paths: pd.paths ?? [], verdict: null, overlapKind: null });
  }
  return holds;
}

const EDGE_WORDS: Record<CoordinationEdge, string> = {
  declared_dependency: 'a declared dependency on',
  inferred_dependency: 'a hard overlap edge on',
  soft_overlap: 'a soft scope overlap with',
  path_lease: 'a live path lease held by',
  open_pr: 'the files of open PR',
};

/** One causal link naming the first hold; null when nothing holds. */
export function coordinationLink(
  holds: CoordinationHold[],
  subject: { taskId?: string | null; workspaceId?: string | null },
): Omit<CausalLink, 'order'> | null {
  const h = holds[0];
  if (!h) return null;
  const who = h.edge === 'open_pr'
    ? `#${h.prNumber}`
    : `task ${h.holderTaskId}${h.holderTitle ? ` ("${h.holderTitle}")` : ''}${h.holderStatus ? `, ${h.holderStatus}` : ''}`;
  const on = h.paths.length > 0 ? ` on ${h.paths.slice(0, 5).join(', ')}` : '';
  const why = h.edge === 'soft_overlap'
    ? h.verdict === 'deterministic_hold'
      ? `; the overlap is ${h.overlapKind ?? 'hard'}, so it waits until that task finishes`
      : `; hold/start verdict: ${h.verdict ?? 'not yet decided (HOLD until it is)'}`
    : h.edge === 'inferred_dependency' && h.overlapKind
      ? ` (${h.overlapKind} overlap; waits until it completes and merges)`
      : '';
  const more = holds.length > 1 ? ` ${holds.length - 1} more hold(s) listed under coordination.` : '';
  const refs: ExplainRefs = {
    ...(h.holderTaskId ? { taskId: h.holderTaskId } : subject.taskId ? { taskId: subject.taskId } : {}),
    ...(subject.workspaceId ? { workspaceId: subject.workspaceId } : {}),
    ...(h.prNumber ? { prNumber: h.prNumber } : {}),
    ...(h.paths.length > 0 ? { paths: h.paths.slice(0, 10) } : {}),
  };
  const derivedFrom = h.edge === 'declared_dependency' || h.edge === 'inferred_dependency'
    ? 'tasks.dependsOn'
    : h.edge === 'soft_overlap'
      ? 'tasks.pathDeclaration.softOverlaps + gate_events'
      : 'gate_events.detail';
  return { claim: `Waiting on ${EDGE_WORDS[h.edge]} ${who}${on}${why}.${more}`, derivedFrom, refs };
}
