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
 * A task that started past an overlap (the claim's `soft_overlap_start`
 * rows: soft overlap, open PR or live lease on mergeable files) is not held:
 * `overlapStartLink` says it "starts alongside #n (same files, merges at the
 * end)", naming the PR, else the holder task.
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
  /** Set when the holder cannot run soon, so the wait is not "next in line". */
  holderStall?: HolderStall | null;
}

export interface CoordinationHolder {
  id: string;
  title: string | null;
  status: string;
  pathManifest: string[] | null;
  /** Why this holder may not run soon; absent when nothing known stops it. */
  stall?: HolderStall | null;
}

/** A pending holder that cannot run soon, in the words explain uses. */
export type HolderStall =
  | { kind: 'deferred'; until: string }
  | { kind: 'credential_hold'; label: string | null }
  | { kind: 'pr_closed_unmerged' };

export function holderStallWords(stall: HolderStall | null | undefined): string | null {
  if (!stall) return null;
  if (stall.kind === 'deferred') return `deferred until ${stall.until}`;
  if (stall.kind === 'credential_hold') return `held for credentials${stall.label ? ` (${stall.label})` : ''}`;
  return 'its PR closed unmerged';
}

/** Deferred beyond this, an inferred edge's holder is not "next in line". */
export const HOLDER_DEFERRED_STALL_MS = 4 * 3_600_000;

export function classifyHolderStall(input: {
  startAt?: Date | string | null;
  context?: unknown;
  prClosedUnmerged?: boolean;
  now?: number;
}): HolderStall | null {
  const ctx = input.context as { credentialHold?: { releasedAt?: string; label?: string } } | null | undefined;
  const hold = ctx?.credentialHold;
  if (hold && typeof hold === 'object' && !hold.releasedAt) return { kind: 'credential_hold', label: typeof hold.label === 'string' ? hold.label : null };
  const at = input.startAt ? new Date(input.startAt).getTime() : NaN;
  if (Number.isFinite(at) && at - (input.now ?? Date.now()) > HOLDER_DEFERRED_STALL_MS) return { kind: 'deferred', until: new Date(at).toISOString() };
  if (input.prClosedUnmerged) return { kind: 'pr_closed_unmerged' };
  return null;
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
      ...(inferred.has(id) && h?.stall ? { holderStall: h.stall } : {}),
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
  const stall = holderStallWords(h.holderStall);
  const stallNote = stall ? ` That task cannot run soon (${stall}), so this wait is not "next in line"; it only yields on its next claim check.` : '';
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
  return { claim: `Waiting on ${EDGE_WORDS[h.edge]} ${who}${on}${why}.${stallNote}${more}`, derivedFrom, refs };
}

/** The words explain and top's Queue both use for a START past an overlap. */
export function startsAlongsideWords(who: string): string {
  return `starts alongside ${who} (same files, merges at the end)`;
}

export interface OverlapStart {
  gate: string;
  holderTaskId: string | null;
  prNumber: number | null;
  paths: string[];
}

/**
 * The overlaps the task's newest claim started past: every `soft_overlap_start`
 * row of that claim (one per holder, same `startedAt`). Rows newest first.
 */
export function latestOverlapStarts(gateDetails: ReadonlyArray<{ reason: string; detail: unknown }>): OverlapStart[] {
  const rows = gateDetails.filter(g => g.reason === 'soft_overlap_start' && g.detail && typeof g.detail === 'object');
  if (rows.length === 0) return [];
  const startedAt = (d: unknown) => (d as Record<string, unknown>).startedAt ?? null;
  const first = startedAt(rows[0].detail);
  return rows
    .filter((g, i) => i === 0 || (first !== null && startedAt(g.detail) === first))
    .map(g => {
      const d = g.detail as Record<string, unknown>;
      const own = coordinationGateDetail(d);
      return {
        gate: typeof d.gate === 'string' ? d.gate : 'soft_overlap',
        holderTaskId: own?.holderTaskId ?? null,
        prNumber: own?.prNumber ?? null,
        paths: own?.paths ?? [],
      };
    });
}

/** Who a START ran alongside, in words: the PR as `#n`, else the holder task. */
export function overlapStartWho(s: OverlapStart): string {
  if (s.prNumber) return `#${s.prNumber}`;
  return s.holderTaskId ? `task ${s.holderTaskId.slice(0, 8)}` : 'other work on its files';
}

/** One causal link for a task that started past an overlap; null when it did not. */
export function overlapStartLink(
  starts: OverlapStart[],
  subject: { taskId?: string | null; workspaceId?: string | null },
): Omit<CausalLink, 'order'> | null {
  const s = starts[0];
  if (!s) return null;
  const on = s.paths.length > 0 ? ` Shared: ${s.paths.slice(0, 5).join(', ')}.` : '';
  const more = starts.length > 1 ? ` It also overlaps ${starts.slice(1).map(overlapStartWho).join(', ')}.` : '';
  const refs: ExplainRefs = {
    ...(subject.taskId ? { taskId: subject.taskId } : {}),
    ...(subject.workspaceId ? { workspaceId: subject.workspaceId } : {}),
    ...(s.prNumber ? { prNumber: s.prNumber } : {}),
    ...(s.paths.length > 0 ? { paths: s.paths.slice(0, 10) } : {}),
  };
  return { claim: `It ${startsAlongsideWords(overlapStartWho(s))}.${on}${more}`, derivedFrom: 'gate_events.detail', refs };
}
