/**
 * Authoritative working set — runner half (docs/specs/path-claim-ownership.md).
 *
 * The task-owned file set is computed from git (branch-owned diff from the PR
 * base plus uncommitted changes, `sweepWorktreeChanges`), kept here with a
 * monotonically increasing generation, and sent to the server as DELTAS since
 * the last ACK — never the cumulative list, never more than `WORKING_SET_CHUNK`
 * paths per side per request. The server's `path_claims` rows are the truth;
 * `acked` is the runner's record of what the server has confirmed holding for
 * this session, so a delta is "what the server does not yet know".
 *
 * Everything here is pure over a plain `WorkingSetState` object (persisted
 * with the worker, so a restart replays from local state and the server's
 * `heldPaths` rather than from scratch). I/O lives in worker-sync.ts (the
 * tick) and ship-checkpoint.ts (the fail-closed full reconciliation).
 */
import type { WorkingSetAck, WorkingSetDelta, WorkingSetCheckpoint } from '@buildd/shared';
import { WORKING_SET_CHUNK } from '@buildd/shared';
import { leasablePaths } from '@buildd/core/path-overlap';

export interface BlockedWorkingPath {
  path: string;
  blockingTaskId: string;
  blockingTaskTitle: string | null;
  blockingPath: string | null;
  /** Earliest time a sync tick re-offers it (a ship checkpoint always does). */
  retryAt: number;
}

export interface WorkingSetState {
  /** Bumps whenever the observed set changes. */
  generation: number;
  /** Generation the server has fully acknowledged (every path offered, none blocked). */
  ackedGeneration: number;
  /** The last observed canonical set, sorted. */
  current: string[];
  /** Paths the server confirmed this task holds, for this session. */
  acked: string[];
  /** Paths a live holder blocked, with the holder. Re-offered after `retryAt`. */
  blocked: BlockedWorkingPath[];
  /** The server's held list has been consulted since this state was created (restart seed). */
  seeded: boolean;
}

/** How long a sync tick waits before re-offering a blocked path (a holder may have released). */
export const BLOCKED_RETRY_MS = 60_000;

export function createWorkingSetState(): WorkingSetState {
  return { generation: 0, ackedGeneration: 0, current: [], acked: [], blocked: [], seeded: false };
}

/** A persisted state from disk may predate a field; fill it in rather than crash. */
export function normalizeWorkingSetState(raw: unknown): WorkingSetState {
  const s = (raw && typeof raw === 'object' ? raw : {}) as Partial<WorkingSetState>;
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((p): p is string => typeof p === 'string') : []);
  return {
    generation: Number.isFinite(s.generation) ? Number(s.generation) : 0,
    ackedGeneration: Number.isFinite(s.ackedGeneration) ? Number(s.ackedGeneration) : 0,
    current: strings(s.current),
    acked: strings(s.acked),
    blocked: Array.isArray(s.blocked)
      ? s.blocked.filter((b): b is BlockedWorkingPath => !!b && typeof b === 'object' && typeof (b as BlockedWorkingPath).path === 'string' && typeof (b as BlockedWorkingPath).blockingTaskId === 'string')
      : [],
    seeded: s.seeded === true,
  };
}

export interface ObservedSweep {
  paths: string[];
  /**
   * False when the sweep could not see the whole set (git failed, or a
   * configured base could not be resolved). Paths may then only be ADDED:
   * a path missing from an incomplete sweep is not evidence it was reverted,
   * and releasing its lease on that evidence would hand it to a sibling.
   */
  trustRemovals: boolean;
}

const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((p, i) => p === b[i]);

/**
 * Record the latest sweep. Returns true when the canonical set changed (and
 * the generation was bumped).
 */
export function observeWorkingSet(state: WorkingSetState, sweep: ObservedSweep): boolean {
  let next = leasablePaths(sweep.paths);
  if (!sweep.trustRemovals) next = [...new Set([...state.current, ...next])];
  next.sort();
  if (sameList(next, state.current)) return false;
  state.current = next;
  state.generation += 1;
  // A blocked path that left the set is no longer anyone's problem.
  const inSet = new Set(next);
  state.blocked = state.blocked.filter(b => inSet.has(b.path));
  return true;
}

export interface NextDeltaOptions {
  now: number;
  chunk?: number;
  /** A ship checkpoint: re-offer every blocked path regardless of `retryAt`, and always send (even an empty delta carries the proof). */
  checkpoint?: WorkingSetCheckpoint;
}

/**
 * The next delta to send, or null when the server already knows everything
 * (and this is not a checkpoint). `add` is bounded to one chunk of paths the
 * server has not acknowledged; `remove` to one chunk of acknowledged paths that
 * left the set. `complete` says whether this delta finishes the job.
 */
export function nextWorkingSetDelta(state: WorkingSetState, opts: NextDeltaOptions): WorkingSetDelta | null {
  const chunk = opts.chunk ?? WORKING_SET_CHUNK;
  const acked = new Set(state.acked);
  const current = new Set(state.current);
  const blockedByPath = new Map(state.blocked.map(b => [b.path, b]));

  const unoffered = state.current.filter(p => !acked.has(p));
  const addCandidates = unoffered.filter(p => {
    const b = blockedByPath.get(p);
    return !b || !!opts.checkpoint || b.retryAt <= opts.now;
  });
  const removeCandidates = state.acked.filter(p => !current.has(p));

  const add = addCandidates.slice(0, chunk);
  const remove = removeCandidates.slice(0, chunk);
  // Complete = after this delta nothing in the set is unoffered: every
  // unoffered path (a throttled blocked one included) fits in this chunk.
  const complete = unoffered.length <= chunk && add.length === unoffered.length && removeCandidates.length <= chunk;

  if (add.length === 0 && remove.length === 0 && !opts.checkpoint && state.seeded) return null;
  if (add.length === 0 && remove.length === 0 && !opts.checkpoint && state.current.length === 0) return null;

  return {
    generation: state.generation,
    add,
    remove,
    complete,
    ...(opts.checkpoint ? { checkpoint: opts.checkpoint } : {}),
    ...(state.seeded ? {} : { includeHeld: true }),
  };
}

/**
 * Fold the server's answer into local state. A delta the server could not
 * apply (closed task) acknowledges nothing. `heldPaths` (restart seed) only
 * contributes what is in the current set: a lease outside it is a declared
 * one this tracker does not manage and must never be "removed" by it.
 */
export function applyWorkingSetAck(state: WorkingSetState, delta: WorkingSetDelta, ack: WorkingSetAck, now: number): void {
  if (!ack.applied) return;
  const blockedPaths = new Set(ack.blocked.map(b => b.path));
  const acked = new Set(state.acked);
  for (const p of delta.add) if (!blockedPaths.has(p)) acked.add(p);
  for (const p of delta.remove) acked.delete(p);
  if (Array.isArray(ack.heldPaths)) {
    const current = new Set(state.current);
    for (const p of leasablePaths(ack.heldPaths)) if (current.has(p)) acked.add(p);
  }
  state.acked = [...acked].sort();
  state.seeded = true;

  const offered = new Set(delta.add);
  const kept = state.blocked.filter(b => !offered.has(b.path) && !acked.has(b.path));
  const fresh: BlockedWorkingPath[] = ack.blocked.map(b => ({
    path: b.path,
    blockingTaskId: b.blockingTaskId,
    blockingTaskTitle: b.blockingTaskTitle ?? null,
    blockingPath: b.blockingPath ?? null,
    retryAt: now + BLOCKED_RETRY_MS,
  }));
  state.blocked = [...kept, ...fresh];

  if (delta.complete && ack.blocked.length === 0 && delta.generation === state.generation) {
    state.ackedGeneration = delta.generation;
  }
}

export type WorkingSetCoverage =
  | { kind: 'complete'; generation: number; heldCount: number }
  | { kind: 'blocked'; blocked: BlockedWorkingPath[] }
  | { kind: 'pending'; remaining: number };

/** Where the local state stands against the server. */
export function workingSetCoverage(state: WorkingSetState): WorkingSetCoverage {
  const acked = new Set(state.acked);
  const blocked = state.blocked.filter(b => !acked.has(b.path));
  if (blocked.length > 0) return { kind: 'blocked', blocked };
  const remaining = state.current.filter(p => !acked.has(p)).length;
  if (remaining > 0 || !state.seeded) return { kind: 'pending', remaining };
  return { kind: 'complete', generation: state.generation, heldCount: state.acked.length };
}

/** Parse the `workingSetAck` field of a PATCH response; null when the server did not answer the delta (an older server). */
export function readWorkingSetAck(response: unknown): WorkingSetAck | null {
  const raw = (response as { workingSetAck?: unknown } | null)?.workingSetAck;
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((p): p is string => typeof p === 'string') : []);
  const blocked = Array.isArray(r.blocked)
    ? (r.blocked as Array<Record<string, unknown>>).filter(b => b && typeof b.path === 'string' && typeof b.blockingTaskId === 'string')
        .map(b => ({
          path: b.path as string,
          blockingTaskId: b.blockingTaskId as string,
          blockingTaskTitle: typeof b.blockingTaskTitle === 'string' ? b.blockingTaskTitle : null,
          blockingPath: typeof b.blockingPath === 'string' ? b.blockingPath : '',
        }))
    : [];
  const coverage = r.coverage === 'complete' || r.coverage === 'blocked' || r.coverage === 'partial' ? r.coverage : 'partial';
  return {
    generation: Number.isFinite(r.generation) ? Number(r.generation) : 0,
    acquired: strings(r.acquired),
    blocked,
    released: strings(r.released),
    heldCount: Number.isFinite(r.heldCount) ? Number(r.heldCount) : 0,
    ...(Array.isArray(r.heldPaths) ? { heldPaths: strings(r.heldPaths) } : {}),
    applied: r.applied !== false,
    coverage,
  };
}
