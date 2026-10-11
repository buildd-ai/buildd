/**
 * Ship checkpoint — the fail-closed full reconciliation before a push,
 * `create_pr` or a successful `complete_task` (docs/specs/path-claim-ownership.md).
 *
 * The invariant it exists for: at a ship boundary buildd either KNOWS the
 * complete current task-owned file set is coordinated, or refuses the ship.
 * So this does not sample, does not trust the bounded observed history, and
 * does not fail open:
 *
 *   1. refresh the PR base (bounded) and recompute the whole owned set from
 *      git — committed diff from the merge-base plus uncommitted changes;
 *   2. drain every outstanding delta to the server, chunked, with bounded
 *      retries on timeout / network error;
 *   3. proceed only on a server ACK that proves complete coverage for this
 *      generation. A blocked path names its holder; an unreachable or
 *      non-answering server is `unknown`, and the caller treats unknown as
 *      refused (enforce) or loudly advisory.
 *
 * The sync tick's deltas are the cheap common case; this is the correctness
 * backstop for lost heartbeats, a runner restart, a file created after the
 * last tick, and a 2,000-file change.
 */
import type { WorkingSetCheckpoint } from '@buildd/shared';
import type { BuilddClient } from './buildd';
import type { LocalWorker, Milestone } from './types';
import { sweepWorktreeChanges, refreshBaseRef, type CollisionSource, type PathCollision } from './path-claim-enforcement';
import {
  createWorkingSetState,
  normalizeWorkingSetState,
  observeWorkingSet,
  nextWorkingSetDelta,
  applyWorkingSetAck,
  workingSetCoverage,
  readWorkingSetAck,
  type BlockedWorkingPath,
} from './working-set';

/** Ceiling on one reconcile round trip at a checkpoint. */
export const CHECKPOINT_SYNC_DEADLINE_MS = 10_000;
/** Ceiling on refreshing the base ref before a checkpoint sweep. */
export const CHECKPOINT_FETCH_DEADLINE_MS = 15_000;
/** Round trips attempted per delta before coverage is declared unknown. */
export const SHIP_CHECKPOINT_ATTEMPTS = 3;
/** Pause before each retry (index = attempt number, 0-based). */
export const SHIP_CHECKPOINT_BACKOFF_MS: readonly number[] = [0, 1_000, 3_000];

export type ShipCheckpointCause = 'timeout' | 'error' | 'sweep_incomplete' | 'server_rejected';

export type ShipCheckpointResult =
  | { kind: 'complete'; generation: number; heldCount: number }
  | { kind: 'blocked'; collision: PathCollision; blocked: PathCollision[] }
  | { kind: 'unknown'; cause: ShipCheckpointCause; attempts: number; detail?: string };

export interface ShipCheckpointDeps {
  buildd: Pick<BuilddClient, 'updateWorker'>;
  addMilestone: (worker: LocalWorker, milestone: Milestone) => void;
  /** Per-round-trip deadline override for tests. */
  deadlineMs?: number;
  /** Fetch the base before sweeping (pre-push/completion). Default false. */
  refreshBase?: boolean;
  attempts?: number;
  backoffMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const TIMED_OUT = Symbol('timed-out');

function withDeadline<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p.finally(() => { if (timer) clearTimeout(timer); }),
    new Promise<typeof TIMED_OUT>(resolve => { timer = setTimeout(() => resolve(TIMED_OUT), ms); }),
  ]);
}

function toCheckpoint(source: CollisionSource): WorkingSetCheckpoint {
  return source === 'completion' ? 'completion' : 'pre_push';
}

export function blockedToCollision(b: BlockedWorkingPath, source: CollisionSource, now: number): PathCollision {
  return {
    path: b.path,
    blockingTaskId: b.blockingTaskId,
    blockingTaskTitle: b.blockingTaskTitle ?? null,
    blockingPath: b.blockingPath ?? null,
    source,
    detectedAt: now,
  };
}

/**
 * Recompute the owned set and reconcile it fully. See the module comment for
 * what each result means to the caller.
 */
export async function runShipCheckpoint(
  worker: LocalWorker,
  source: CollisionSource,
  deps: ShipCheckpointDeps,
): Promise<ShipCheckpointResult> {
  const root = worker.worktreePath;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
  const attempts = Math.max(1, deps.attempts ?? SHIP_CHECKPOINT_ATTEMPTS);
  const backoff = deps.backoffMs ?? SHIP_CHECKPOINT_BACKOFF_MS;
  const deadline = deps.deadlineMs ?? CHECKPOINT_SYNC_DEADLINE_MS;

  // Nothing on disk means nothing this session could own.
  if (!root) return { kind: 'complete', generation: 0, heldCount: 0 };

  if (deps.refreshBase) {
    await refreshBaseRef(root, worker.prBaseRef, CHECKPOINT_FETCH_DEADLINE_MS);
  }
  // The PR base, not the worktree base: on a resume the worktree was cut from
  // the prior attempt's branch, and measuring against that drops every file
  // earlier attempts committed (see resolvePrBaseRef).
  const sweep = sweepWorktreeChanges(root, worker.prBaseRef);
  if (sweep.error) {
    return { kind: 'unknown', cause: 'sweep_incomplete', attempts: 0, detail: sweep.error };
  }
  if (worker.prBaseRef && !sweep.baseResolved) {
    // A configured base that cannot be resolved means the committed half of
    // the set is unknown. Guessing trunk would be wrong on a mission branch;
    // shipping on an unknown set is exactly what this checkpoint refuses.
    return { kind: 'unknown', cause: 'sweep_incomplete', attempts: 0, detail: `base ${worker.prBaseRef} not resolvable` };
  }

  const state = worker.workingSet = normalizeWorkingSetState(worker.workingSet ?? createWorkingSetState());
  observeWorkingSet(state, { paths: sweep.paths, trustRemovals: true });
  if (state.current.length === 0 && state.acked.length === 0) {
    return { kind: 'complete', generation: state.generation, heldCount: 0 };
  }

  const checkpoint = toCheckpoint(source);
  // Bound the drain: every chunk moves at least one path, plus the final proof.
  const maxRounds = Math.ceil((state.current.length + state.acked.length) / 1) + 2;
  let rounds = 0;
  let totalAttempts = 0;
  while (rounds++ < maxRounds) {
    const delta = nextWorkingSetDelta(state, { now: now(), checkpoint });
    if (!delta) break;

    let response: unknown = TIMED_OUT;
    let lastCause: ShipCheckpointCause = 'timeout';
    let lastDetail: string | undefined;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const pause = backoff[Math.min(attempt, backoff.length - 1)] ?? 0;
      if (attempt > 0 && pause > 0) await sleep(pause);
      totalAttempts += 1;
      try {
        const result = await withDeadline(
          Promise.resolve().then(() => deps.buildd.updateWorker(worker.id, { workingSet: delta })),
          deadline,
        );
        if (result === TIMED_OUT) { lastCause = 'timeout'; continue; }
        response = result;
        break;
      } catch (err) {
        lastCause = 'error';
        lastDetail = err instanceof Error ? err.message.split('\n')[0] : String(err);
      }
    }
    if (response === TIMED_OUT) {
      deps.addMilestone(worker, {
        type: 'status',
        label: `Ship checkpoint: path coverage unknown (${lastCause}) after ${totalAttempts} attempt(s)`,
        ts: now(),
      } as Milestone);
      return { kind: 'unknown', cause: lastCause, attempts: totalAttempts, detail: lastDetail };
    }

    const ack = readWorkingSetAck(response);
    if (!ack) {
      return { kind: 'unknown', cause: 'server_rejected', attempts: totalAttempts, detail: 'server did not acknowledge the working set' };
    }
    applyWorkingSetAck(state, delta, ack, now());
    if (!ack.applied) {
      return { kind: 'unknown', cause: 'server_rejected', attempts: totalAttempts, detail: 'task is not open for leases' };
    }
    if (delta.complete) break;
  }

  const coverage = workingSetCoverage(state);
  if (coverage.kind === 'blocked') {
    const blocked = coverage.blocked.map(b => blockedToCollision(b, source, now()));
    return { kind: 'blocked', collision: blocked[0], blocked };
  }
  if (coverage.kind === 'pending') {
    return { kind: 'unknown', cause: 'server_rejected', attempts: totalAttempts, detail: `${coverage.remaining} path(s) never acknowledged` };
  }
  return { kind: 'complete', generation: coverage.generation, heldCount: coverage.heldCount };
}

/**
 * Compatibility shape for callers that only want the first collision (the
 * sync-tick collision flow). `unknown` and `complete` are both null here —
 * the ship guard is what acts on `unknown`.
 */
export function collisionOf(result: ShipCheckpointResult): PathCollision | null {
  return result.kind === 'blocked' ? result.collision : null;
}
