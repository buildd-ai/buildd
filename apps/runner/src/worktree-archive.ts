/**
 * Archive-before-remove, and checkpoint-on-abnormal-termination.
 *
 * `git worktree remove --force` exits 0 on a dirty tree, so a removal that only
 * guards unpushed *commits* silently deletes uncommitted edits and untracked
 * files. Every runner-side removal goes through `archiveWorktreeWork` first
 * (via `removeWorktreeIfUnowned`): bundle for commits not on any remote, patch
 * for tracked edits plus untracked non-ignored files. If the archive cannot be
 * written the caller keeps the tree.
 *
 * `checkpointWorktree` is the stronger form for a worker that died of a
 * usage/session limit: commit a WIP checkpoint on the task branch and push it,
 * falling back to the archive when the push is impossible. The result names
 * where the work went so the next attempt can resume from it.
 */
import { execFile, execFileSync } from 'child_process';
import { promisify } from 'util';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { resolveBuilddHome } from './buildd-home';

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT_MS = 30_000;
const PUSH_TIMEOUT_MS = 60_000;
const MAX_BUFFER = 256 * 1024 * 1024;

export const defaultArchiveDir = (): string => join(resolveBuilddHome(), 'archive');

async function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv, timeout = GIT_TIMEOUT_MS): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd, encoding: 'utf-8', timeout, maxBuffer: MAX_BUFFER, ...(env ? { env } : {}),
  });
  return stdout;
}

function gitSync(cwd: string, args: string[], env?: NodeJS.ProcessEnv): string {
  return execFileSync('git', args, {
    cwd, encoding: 'utf-8', timeout: GIT_TIMEOUT_MS, maxBuffer: MAX_BUFFER,
    stdio: ['ignore', 'pipe', 'pipe'], ...(env ? { env } : {}),
  });
}

/** Commits at HEAD not on any remote. Fail-closed: an unanswerable probe is "yes". */
export async function hasUnpushedCommits(worktreePath: string): Promise<boolean> {
  try {
    return Number((await git(worktreePath, ['rev-list', '--count', 'HEAD', '--not', '--remotes'])).trim()) > 0;
  } catch {
    return true;
  }
}

/**
 * Uncommitted work as a binary patch against HEAD: tracked edits AND
 * untracked, non-ignored files. Built in a throwaway index so the worktree's
 * own index is never touched. '' for none, null if unreadable (keep the tree).
 */
export async function uncommittedPatch(worktreePath: string): Promise<string | null> {
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

function uncommittedPatchSync(worktreePath: string): string | null {
  const tmp = mkdtempSync(join(tmpdir(), 'buildd-sweep-index-'));
  try {
    const env = { ...process.env, GIT_INDEX_FILE: join(tmp, 'index') };
    gitSync(worktreePath, ['read-tree', 'HEAD'], env);
    gitSync(worktreePath, ['add', '-A'], env);
    const diff = gitSync(worktreePath, ['diff', '--cached', '--binary', 'HEAD'], env);
    return diff.trim() ? diff : '';
  } catch {
    return null;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export interface ArchiveResult {
  /** False when the tree held nothing that exists nowhere else. */
  archived: boolean;
  bundle?: string;
  patch?: string;
}

/**
 * Write a bundle (unpushed commits) and/or patch (uncommitted + untracked) for
 * `worktreePath` into `archiveDir`. Throws if anything that needed saving could
 * not be — the caller must then keep the tree.
 */
export async function archiveWorktreeWork(worktreePath: string, id: string, archiveDir = defaultArchiveDir()): Promise<ArchiveResult> {
  const unpushed = await hasUnpushedCommits(worktreePath);
  const patch = await uncommittedPatch(worktreePath);
  if (patch === null) throw new Error('could not read uncommitted changes');
  if (!unpushed && patch === '') return { archived: false };
  mkdirSync(archiveDir, { recursive: true });
  const result: ArchiveResult = { archived: true };
  if (unpushed) {
    result.bundle = join(archiveDir, `${id}.bundle`);
    await git(worktreePath, ['bundle', 'create', result.bundle, 'HEAD', '--not', '--remotes']);
  }
  if (patch) {
    result.patch = join(archiveDir, `${id}.patch`);
    writeFileSync(result.patch, patch);
  }
  return result;
}

/** Synchronous twin for `destroy()`, which has no event loop left to await on. */
export function archiveWorktreeWorkSync(worktreePath: string, id: string, archiveDir = defaultArchiveDir()): ArchiveResult {
  let unpushed = true;
  try {
    unpushed = Number(gitSync(worktreePath, ['rev-list', '--count', 'HEAD', '--not', '--remotes']).trim()) > 0;
  } catch { /* fail closed */ }
  const patch = uncommittedPatchSync(worktreePath);
  if (patch === null) throw new Error('could not read uncommitted changes');
  if (!unpushed && patch === '') return { archived: false };
  mkdirSync(archiveDir, { recursive: true });
  const result: ArchiveResult = { archived: true };
  if (unpushed) {
    result.bundle = join(archiveDir, `${id}.bundle`);
    gitSync(worktreePath, ['bundle', 'create', result.bundle, 'HEAD', '--not', '--remotes']);
  }
  if (patch) {
    result.patch = join(archiveDir, `${id}.patch`);
    writeFileSync(result.patch, patch);
  }
  return result;
}

export type CheckpointResult =
  | { kind: 'none' }
  | { kind: 'pushed'; branch: string; sha: string; ref: string }
  | { kind: 'archived'; ref: string; bundle?: string; patch?: string; sha?: string }
  | { kind: 'failed'; error: string };

/**
 * Preserve a dying worker's work. Nothing to save → `none`. Otherwise commit
 * any uncommitted/untracked work as a WIP checkpoint and push HEAD to the task
 * branch; if the push fails, fall back to the bundle+patch archive. `failed`
 * means neither worked — the caller must keep the worktree.
 */
export async function checkpointWorktree(opts: {
  worktreePath: string;
  branch: string;
  workerId: string;
  reason: string;
  archiveDir?: string;
}): Promise<CheckpointResult> {
  const { worktreePath, branch, workerId, reason } = opts;
  try {
    const dirty = (await git(worktreePath, ['status', '--porcelain'])).trim() !== '';
    const unpushed = await hasUnpushedCommits(worktreePath);
    if (!dirty && !unpushed) return { kind: 'none' };

    if (dirty) {
      await git(worktreePath, ['add', '-A']);
      await git(worktreePath, [
        '-c', 'user.name=buildd-runner', '-c', 'user.email=runner@buildd.invalid',
        'commit', '--no-verify', '-m', `wip: checkpoint after ${reason} (worker ${workerId.slice(0, 8)})`,
      ]);
    }
    const sha = (await git(worktreePath, ['rev-parse', 'HEAD'])).trim();
    try {
      await git(worktreePath, ['push', 'origin', `HEAD:refs/heads/${branch}`], undefined, PUSH_TIMEOUT_MS);
      return { kind: 'pushed', branch, sha, ref: `origin/${branch}@${sha}` };
    } catch {
      const a = await archiveWorktreeWork(worktreePath, workerId, opts.archiveDir);
      const ref = `archive:${a.bundle ?? a.patch}`;
      return { kind: 'archived', ref, bundle: a.bundle, patch: a.patch, sha };
    }
  } catch (err) {
    return { kind: 'failed', error: err instanceof Error ? err.message.split('\n')[0] : String(err) };
  }
}
