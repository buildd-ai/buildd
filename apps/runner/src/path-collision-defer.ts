/**
 * The collision hand-off
 * (knowledge-base: buildd/design/conflict-aware-orchestration.md §2).
 *
 * The pre-push / completion sweep itself moved to ship-checkpoint.ts, where it
 * became the fail-closed full reconciliation of the authoritative working set
 * (docs/specs/path-claim-ownership.md). What stays here is what a confirmed
 * collision does:
 *
 * `deferOnPathCollision` is the enforce-mode response: persist the state,
 * write a checkpoint commit, report a `Deferred:` failure (the server requeues
 * that without charging a retry, and records the collision so the claim route
 * holds the task until the holder releases), and end the session. No agent
 * stays alive waiting for a lease.
 */
import * as childProcess from 'child_process';
import type { BuilddClient } from './buildd';
import type { LocalWorker, Milestone } from './types';
import {
  toCollision,
  collisionDeferralError,
  shortTaskId,
  type CollisionSource,
  type PathCollision,
} from './path-claim-enforcement';

export { CHECKPOINT_SYNC_DEADLINE_MS, CHECKPOINT_FETCH_DEADLINE_MS } from './ship-checkpoint';

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
  // env must be passed explicitly: Bun's execFileSync snapshots process.env
  // at process startup rather than reading it per call (unlike Node's), so a
  // caller that mutates process.env at runtime (e.g. a test clearing git
  // identity) would otherwise never reach this child process.
  return String(childProcess.execFileSync('git', args, {
    cwd, timeout, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], env: process.env,
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
