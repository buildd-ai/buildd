/**
 * Reclaim worktrees of workers that are terminal on disk but not in memory.
 *
 * `WorkerSync.evictCompletedWorkers` removes a terminal worker's worktree, but
 * only for workers in memory. `restoreWorkersFromDisk` leaves records that were
 * already done/error before a restart on disk, unloaded — so after a restart
 * nothing ever reclaimed those worktrees, each a full checkout with its own
 * node_modules. The periodic sweep (doctor.ts) keeps any whose branch is
 * unpushed, which is the common case for a failed worker.
 *
 * Here: pushed and clean → remove. Unpushed commits or tracked edits → write a
 * git bundle (commits not on any remote) and a patch (tracked uncommitted
 * edits) into `archiveDir`, then remove. If the archive can't be written, keep
 * the worktree. `git worktree remove` leaves the branch ref in place, so the
 * bundle is a second copy, not the only one.
 */
import { execSync } from 'child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
  isRunnerWorktreePath,
  isWorktreePathOwnedByOtherLiveWorker,
  WORKTREE_DIR_MARKER,
  type WorktreeOwnershipRecord,
} from './worktree-utils';

export interface SweepRecord {
  id: string;
  status: string;
  worktreePath?: string;
  branch?: string;
  lastActivity: number;
}

export type SweepOutcome = 'removed' | 'archived' | 'kept' | 'missing';

export interface SweepTerminalWorktreesOptions {
  records: Iterable<SweepRecord>;
  liveWorkers: Iterable<[string, WorktreeOwnershipRecord]>;
  now: number;
  /** Same window eviction uses: a just-finished worker may still be resumed. */
  retentionMs: number;
  archiveDir: string;
}

const GIT_TIMEOUT_MS = 30_000;

function git(cwd: string, args: string): string {
  return execSync(`git ${args}`, { cwd, encoding: 'utf-8', stdio: 'pipe', timeout: GIT_TIMEOUT_MS });
}

function mainRepoFor(worktreePath: string): string {
  const idx = worktreePath.indexOf(`/${WORKTREE_DIR_MARKER}`);
  return idx > 0 ? worktreePath.slice(0, idx) : worktreePath;
}

/** Commits at HEAD not on any remote. Fail-closed: an unanswerable probe is "yes". */
function hasUnpushedCommits(worktreePath: string): boolean {
  try {
    return Number(git(worktreePath, 'rev-list --count HEAD --not --remotes').trim()) > 0;
  } catch {
    return true;
  }
}

/** Tracked, uncommitted changes. Untracked files (node_modules, build output) are not work. */
function trackedDiff(worktreePath: string): string | null {
  try {
    const diff = git(worktreePath, 'diff HEAD --binary');
    return diff.trim() ? diff : '';
  } catch {
    return null;
  }
}

function remove(repoPath: string, worktreePath: string): void {
  try {
    git(repoPath, `worktree remove --force "${worktreePath}"`);
  } catch {
    rmSync(worktreePath, { recursive: true, force: true });
    try { git(repoPath, 'worktree prune'); } catch { /* best effort */ }
  }
}

export function sweepTerminalWorktrees(opts: SweepTerminalWorktreesOptions): Array<{ id: string; outcome: SweepOutcome }> {
  const live = [...opts.liveWorkers];
  const results: Array<{ id: string; outcome: SweepOutcome }> = [];

  for (const rec of opts.records) {
    if (rec.status !== 'done' && rec.status !== 'error') continue;
    const path = rec.worktreePath;
    // Never touch a directory the runner did not create (the base clone, a
    // human's worktree, an SDK subagent tree).
    if (!path || !isRunnerWorktreePath(path)) continue;
    if (opts.now - rec.lastActivity < opts.retentionMs) continue;
    // Worktree paths are branch-keyed: a retry can already be sitting here.
    if (isWorktreePathOwnedByOtherLiveWorker(live, path, rec.id)) continue;
    if (!existsSync(path)) {
      results.push({ id: rec.id, outcome: 'missing' });
      continue;
    }

    const repoPath = mainRepoFor(path);
    const unpushed = hasUnpushedCommits(path);
    const diff = trackedDiff(path);
    const needsArchive = unpushed || diff !== '';

    if (needsArchive) {
      try {
        mkdirSync(opts.archiveDir, { recursive: true });
        if (unpushed) {
          git(path, `bundle create "${join(opts.archiveDir, `${rec.id}.bundle`)}" HEAD --not --remotes`);
        }
        if (diff === null) throw new Error('could not read tracked changes');
        if (diff) writeFileSync(join(opts.archiveDir, `${rec.id}.patch`), diff);
      } catch (err) {
        console.warn(
          `[worktree-sweep] keeping ${path} (worker ${rec.id}): archive failed — ` +
          (err instanceof Error ? err.message.split('\n')[0] : String(err)),
        );
        results.push({ id: rec.id, outcome: 'kept' });
        continue;
      }
    }

    console.log(
      `[worktree-sweep] removing terminal worktree ${path} (worker ${rec.id}, status=${rec.status}` +
      `${needsArchive ? `, archived to ${opts.archiveDir}` : ''})`,
    );
    remove(repoPath, path);
    results.push({ id: rec.id, outcome: needsArchive ? 'archived' : 'removed' });
  }
  return results;
}
