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
 * Here: pushed and clean → remove. Unpushed commits or uncommitted work →
 * write a git bundle (commits not on any remote) and a patch (tracked edits
 * plus untracked, non-ignored files) into `archiveDir`, then remove. If the
 * archive can't be written, keep the worktree. `git worktree remove` leaves the
 * branch ref in place, so the bundle is a second copy, not the only one.
 *
 * Git runs asynchronously and a pass is capped: the sweep runs on the runner's
 * event loop, and `worktree remove` over a tree full of node_modules is slow.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { isRunnerWorktreePath, WORKTREE_DIR_MARKER } from './worktree-utils';

const execFileAsync = promisify(execFile);

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
  /**
   * Every worker in memory, ANY status. A non-terminal one may be running in
   * the path (paths are branch-keyed, so a retry can sit where an old record
   * points); a done/error one is inside its resume window. Either way the
   * sweep is not the owner — eviction is.
   */
  inMemoryWorkers: Iterable<[string, { worktreePath?: string; status?: string }]>;
  /**
   * Repos with a `setupWorktree` in flight. The new worker's worktreePath is
   * only set once setup (including the dependency install) returns, so its
   * directory is unowned in the meantime — skip the whole repo.
   *
   * This and `inMemoryWorkers` are read live — per record, and again right
   * before removal: the pass awaits git, and a claim can land meanwhile.
   */
  busyRepos?: { has(repoPath: string): boolean };
  /** Records already found `kept` this process; not retried every pass. */
  skipIds?: ReadonlySet<string>;
  /** Cap on worktrees examined per pass (default 10). */
  maxPerPass?: number;
  now: number;
  /** Same window eviction uses: a just-finished worker may still be resumed. */
  retentionMs: number;
  archiveDir: string;
}

const GIT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_PER_PASS = 10;
const MAX_BUFFER = 256 * 1024 * 1024;

async function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    encoding: 'utf-8',
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: MAX_BUFFER,
    ...(env ? { env } : {}),
  });
  return stdout;
}

export function mainRepoFor(worktreePath: string): string {
  const idx = worktreePath.indexOf(`/${WORKTREE_DIR_MARKER}`);
  return idx > 0 ? worktreePath.slice(0, idx) : worktreePath;
}

/** Commits at HEAD not on any remote. Fail-closed: an unanswerable probe is "yes". */
async function hasUnpushedCommits(worktreePath: string): Promise<boolean> {
  try {
    return Number((await git(worktreePath, ['rev-list', '--count', 'HEAD', '--not', '--remotes'])).trim()) > 0;
  } catch {
    return true;
  }
}

/**
 * Uncommitted work as a binary patch against HEAD: tracked edits AND
 * untracked, non-ignored files (a new source file the agent never `git add`ed
 * is work; node_modules and build output are gitignored). Built in a
 * throwaway index so the worktree's own index is never touched. Returns ''
 * for none, null if it could not be read (the caller keeps the tree).
 */
async function uncommittedPatch(worktreePath: string): Promise<string | null> {
  const tmp = await mkdtemp(join(tmpdir(), 'buildd-sweep-index-'));
  try {
    const env = { ...process.env, GIT_INDEX_FILE: join(tmp, 'index') };
    await git(worktreePath, ['read-tree', 'HEAD'], env);
    await git(worktreePath, ['add', '-A'], env);
    const diff = await git(worktreePath, ['diff', '--cached', '--binary', 'HEAD'], env);
    return diff.trim() ? diff : '';
  } catch {
    return null;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

async function remove(repoPath: string, worktreePath: string): Promise<void> {
  try {
    await git(repoPath, ['worktree', 'remove', '--force', worktreePath]);
  } catch {
    rmSync(worktreePath, { recursive: true, force: true });
    try { await git(repoPath, ['worktree', 'prune']); } catch { /* best effort */ }
  }
}

export async function sweepTerminalWorktrees(opts: SweepTerminalWorktreesOptions): Promise<Array<{ id: string; outcome: SweepOutcome }>> {
  const claimed = (path: string, repoPath: string): boolean => {
    if (opts.busyRepos?.has(repoPath)) return true;
    for (const [, w] of opts.inMemoryWorkers) if (w.worktreePath === path) return true;
    return false;
  };
  const maxPerPass = opts.maxPerPass ?? DEFAULT_MAX_PER_PASS;
  const results: Array<{ id: string; outcome: SweepOutcome }> = [];
  let examined = 0;

  for (const rec of opts.records) {
    if (examined >= maxPerPass) break;
    if (rec.status !== 'done' && rec.status !== 'error') continue;
    if (opts.skipIds?.has(rec.id)) continue;
    const path = rec.worktreePath;
    // Never touch a directory the runner did not create (the base clone, a
    // human's worktree, an SDK subagent tree).
    if (!path || !isRunnerWorktreePath(path)) continue;
    if (opts.now - rec.lastActivity < opts.retentionMs) continue;
    const repoPath = mainRepoFor(path);
    if (claimed(path, repoPath)) continue;
    if (!existsSync(path)) {
      results.push({ id: rec.id, outcome: 'missing' });
      continue;
    }
    examined++;

    const unpushed = await hasUnpushedCommits(path);
    const patch = await uncommittedPatch(path);
    const needsArchive = unpushed || patch !== '';

    if (needsArchive) {
      try {
        mkdirSync(opts.archiveDir, { recursive: true });
        if (unpushed) {
          await git(path, ['bundle', 'create', join(opts.archiveDir, `${rec.id}.bundle`), 'HEAD', '--not', '--remotes']);
        }
        if (patch === null) throw new Error('could not read uncommitted changes');
        if (patch) writeFileSync(join(opts.archiveDir, `${rec.id}.patch`), patch);
      } catch (err) {
        console.warn(
          `[worktree-sweep] keeping ${path} (worker ${rec.id}): archive failed — ` +
          (err instanceof Error ? err.message.split('\n')[0] : String(err)),
        );
        results.push({ id: rec.id, outcome: 'kept' });
        continue;
      }
    }

    // The archive steps awaited git; re-check before the destructive step.
    if (claimed(path, repoPath)) continue;

    console.log(
      `[worktree-sweep] removing terminal worktree ${path} (worker ${rec.id}, status=${rec.status}` +
      `${needsArchive ? `, archived to ${opts.archiveDir}` : ''})`,
    );
    await remove(repoPath, path);
    results.push({ id: rec.id, outcome: needsArchive ? 'archived' : 'removed' });
  }
  return results;
}
