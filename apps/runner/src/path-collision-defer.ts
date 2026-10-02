/**
 * Checkpoint enforcement and the collision hand-off
 * (knowledge-base: buildd/design/conflict-aware-orchestration.md §2).
 *
 * `runCheckpointSweep` is the pre-push / completion sweep: the worktree's
 * changes against the task's resolved PR base (Bash and untracked writes
 * included) go to the server's exclusive acquisition through the ordinary
 * worker PATCH, and any path another live task holds comes back as a
 * collision. Bounded fail-open: an unreachable server records degraded
 * enforcement and lets the ship through.
 *
 * `deferOnPathCollision` is what a confirmed collision does in enforce mode:
 * persist the state, write a checkpoint commit, report a `Deferred:` failure
 * (the server requeues that without charging a retry, and records the
 * collision so the claim route holds the task until the holder releases), and
 * end the session. No agent stays alive waiting for a lease.
 */
import * as childProcess from 'child_process';
import type { BuilddClient } from './buildd';
import type { LocalWorker, Milestone } from './types';
import {
  sweepWorktreeChanges,
  refreshBaseRef,
  toCollision,
  collisionDeferralError,
  shortTaskId,
  type CollisionSource,
  type PathCollision,
} from './path-claim-enforcement';

/** Ceiling on the sweep's server round trip at a checkpoint. */
export const CHECKPOINT_SYNC_DEADLINE_MS = 10_000;
/** Ceiling on refreshing the base ref before a checkpoint sweep. */
export const CHECKPOINT_FETCH_DEADLINE_MS = 15_000;

export interface CheckpointSweepDeps {
  buildd: Pick<BuilddClient, 'updateWorker'>;
  addMilestone: (worker: LocalWorker, milestone: Milestone) => void;
  /** Override for tests. */
  deadlineMs?: number;
  /** Fetch the base before sweeping (pre-push/completion). Default false. */
  refreshBase?: boolean;
}

function withDeadline<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p.finally(() => { if (timer) clearTimeout(timer); }),
    new Promise<typeof TIMED_OUT>(resolve => { timer = setTimeout(() => resolve(TIMED_OUT), ms); }),
  ]);
}
const TIMED_OUT = Symbol('timed-out');

function markDegraded(worker: LocalWorker, deps: CheckpointSweepDeps, why: string) {
  const first = !worker.pathClaimDegraded;
  worker.pathClaimDegraded = (worker.pathClaimDegraded ?? 0) + 1;
  console.log(`[Worker ${worker.id}] Checkpoint sweep could not reach the server (${why}) — allowing; enforcement degraded`);
  if (first) {
    deps.addMilestone(worker, {
      type: 'status',
      label: `Path-claim checkpoint unavailable (${why}): continuing — enforcement degraded`,
      ts: Date.now(),
    } as Milestone);
  }
}

/**
 * Sweep the worktree and offer it to the server. Returns the first collision
 * the server reports, or null (nothing changed, nothing held, or the server
 * could not be reached in time).
 */
export async function runCheckpointSweep(
  worker: LocalWorker,
  source: CollisionSource,
  deps: CheckpointSweepDeps,
): Promise<PathCollision | null> {
  const root = worker.worktreePath;
  if (!root) return null;

  if (deps.refreshBase) {
    await refreshBaseRef(root, worker.prBaseRef, CHECKPOINT_FETCH_DEADLINE_MS);
  }
  // The PR base, not the worktree base: on a resume the worktree was cut from
  // the prior attempt's branch, and measuring against that drops every file
  // earlier attempts committed (see resolvePrBaseRef).
  const sweep = sweepWorktreeChanges(root, worker.prBaseRef);
  if (sweep.paths.length === 0) return null;

  let response: unknown;
  try {
    const result = await withDeadline(
      Promise.resolve().then(() => deps.buildd.updateWorker(worker.id, {
        touchedPaths: sweep.paths,
        // Re-offer the whole sweep, not only paths new to the server: a path
        // observed earlier whose acquisition failed or was lost is otherwise
        // never offered again, and this is the last chance before it ships.
        ...(source === 'pre_push' || source === 'completion' ? { checkpointSweep: true } : {}),
      })),
      deps.deadlineMs ?? CHECKPOINT_SYNC_DEADLINE_MS,
    );
    if (result === TIMED_OUT) {
      markDegraded(worker, deps, 'timeout');
      return null;
    }
    response = result;
  } catch (err) {
    markDegraded(worker, deps, err instanceof Error ? err.message.split('\n')[0] : 'error');
    return null;
  }
  return firstCollision(response, source);
}

/** The first well-formed entry of a PATCH response's `pathCollisions`. */
export function firstCollision(response: unknown, source: CollisionSource): PathCollision | null {
  const list = (response as { pathCollisions?: unknown } | null)?.pathCollisions;
  if (!Array.isArray(list)) return null;
  for (const raw of list) {
    const c = toCollision(raw, source);
    if (c) return c;
  }
  return null;
}

export interface CollisionCheckpoint {
  committed: boolean;
  sha?: string;
  pushed: boolean;
  /** Why it was not pushed, when it was not. */
  reason?: string;
}

function git(cwd: string, args: string[], timeout = 30_000): string {
  return String(childProcess.execFileSync('git', args, {
    cwd, timeout, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'],
  }));
}

/** Identity a checkpoint commit falls back to; same one park.ts uses for its WIP commit. */
export const CHECKPOINT_FALLBACK_IDENTITY = { name: 'buildd', email: 'checkpoint@buildd.invalid' } as const;

/**
 * `-c user.name/-c user.email` overrides, only when git has no usable identity
 * of its own (`git var` uses the same strict check `commit` does). A runner
 * host with no global git config (CI, a fresh container) would otherwise fail
 * the checkpoint commit, and the deferral would lose the work it exists to save.
 * A configured identity, including GIT_AUTHOR_* / GIT_COMMITTER_* env, is kept.
 */
export function identityFallbackArgs(cwd: string): string[] {
  const missing = (v: 'GIT_AUTHOR_IDENT' | 'GIT_COMMITTER_IDENT') => {
    try { git(cwd, ['var', v], 5_000); return false; } catch { return true; }
  };
  if (!missing('GIT_AUTHOR_IDENT') && !missing('GIT_COMMITTER_IDENT')) return [];
  return ['-c', `user.name=${CHECKPOINT_FALLBACK_IDENTITY.name}`, '-c', `user.email=${CHECKPOINT_FALLBACK_IDENTITY.email}`];
}

/**
 * Commit everything the worktree holds (gitignore respected) as a checkpoint
 * and, when `push`, push the task branch so a deferred retry on any runner can
 * resume from it. Hooks are skipped: this is a save, not a ship.
 */
export function writeCollisionCheckpoint(
  cwd: string,
  branch: string | undefined,
  collision: PathCollision,
  opts: { push: boolean },
): CollisionCheckpoint {
  const out: CollisionCheckpoint = { committed: false, pushed: false };
  try {
    const dirty = git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all']).length > 0;
    if (dirty) {
      git(cwd, ['add', '-A']);
      git(cwd, [
        ...identityFallbackArgs(cwd),
        '-c', 'commit.gpgsign=false',
        'commit', '--no-verify', '-q', '-m',
        `chore(checkpoint): defer on path collision with task ${shortTaskId(collision.blockingTaskId)}\n\n` +
        `${collision.path} is held by another live task. Saved by the buildd runner so a later attempt can resume.`,
      ]);
      out.committed = true;
    }
    out.sha = git(cwd, ['rev-parse', 'HEAD']).trim();
  } catch (err) {
    out.reason = `commit failed: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`;
    return out;
  }
  if (!opts.push) {
    out.reason = out.reason ?? 'push skipped';
    return out;
  }
  if (!branch) {
    out.reason = 'no task branch';
    return out;
  }
  try {
    git(cwd, ['push', '--no-verify', '-q', 'origin', `HEAD:refs/heads/${branch}`]);
    out.pushed = true;
  } catch (err) {
    out.reason = `push failed: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`;
  }
  return out;
}

export interface DeferDeps {
  buildd: Pick<BuilddClient, 'updateWorker'>;
  abort: (workerId: string, reason?: string) => Promise<void>;
  save: (worker: LocalWorker) => void;
  addMilestone: (worker: LocalWorker, milestone: Milestone) => void;
}

/**
 * The enforce-mode response to a confirmed collision. Runs once per worker.
 *
 * With an open PR the checkpoint stays local: pushing would put the colliding
 * change on the PR, which is exactly what stopping the push is for. Without
 * one, the task branch is pushed (it is not a PR) so the requeued task can
 * resume from it on any runner.
 */
export async function deferOnPathCollision(
  worker: LocalWorker,
  collision: PathCollision,
  deps: DeferDeps,
): Promise<void> {
  if (worker.pathCollisionDeferring) return;
  worker.pathCollisionDeferring = true;
  worker.pathCollision = worker.pathCollision ?? collision;
  const c = worker.pathCollision;
  deps.save(worker);

  const error = collisionDeferralError(c);
  deps.addMilestone(worker, { type: 'status', label: `Path collision on ${c.path}: checkpointing and deferring`, ts: Date.now() } as Milestone);

  const checkpoint: CollisionCheckpoint = worker.worktreePath
    ? writeCollisionCheckpoint(worker.worktreePath, worker.branch, c, { push: !worker.prUrl })
    : { committed: false, pushed: false, reason: 'no worktree' };
  if (worker.prUrl && !checkpoint.reason?.startsWith('commit failed')) checkpoint.reason = 'open PR: checkpoint kept local';

  worker.error = error;
  deps.save(worker);
  try {
    await deps.buildd.updateWorker(worker.id, {
      status: 'failed',
      error,
      pathCollision: { ...c, checkpoint },
    } as Parameters<BuilddClient['updateWorker']>[1]);
  } catch (err) {
    console.warn(`[Worker ${worker.id}] Could not report the path-collision deferral: ${err instanceof Error ? err.message : String(err)}`);
  }
  // Always end the session: a deferral never keeps an agent alive waiting.
  await deps.abort(worker.id, error);
}
