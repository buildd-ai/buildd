/**
 * One writer at a time per git repository (its common dir).
 *
 * Every worktree of a primary clone shares one `.git`: its config, packed-refs,
 * `worktrees/` and `info/`. While worktree setup ran git synchronously, two
 * claims on the same clone could not interleave. Now that it is async they can,
 * and git's lock files (`config.lock`, `packed-refs.lock`, `index.lock`) make a
 * concurrent writer fail at once: a `git config` that loses the race skips
 * core.hooksPath, a merge driver or a branch upstream, and a `worktree add`
 * that loses fails the setup. So the sequences that write the common dir run
 * under this lock, keyed by the realpath of the common dir, so a primary clone
 * and any of its worktrees share one key.
 *
 * Not reentrant: a holder must not call another locked function on the same
 * repo.
 */
import { existsSync, readFileSync, realpathSync, statSync } from 'fs';
import { basename, dirname, isAbsolute, join, resolve } from 'path';

const tails = new Map<string, Promise<void>>();

function real(p: string): string {
  try { return realpathSync(p); } catch { return resolve(p); }
}

/**
 * The git common dir for a primary clone or one of its worktrees, from the
 * filesystem alone (no git child): `<repo>/.git` when it is a directory;
 * otherwise the worktree's `gitdir:` pointer and its `commondir` file. Any
 * other shape falls back to the path itself, which still serializes callers
 * that name the same path.
 */
export function gitCommonDirKey(repoOrWorktree: string): string {
  const dotGit = join(repoOrWorktree, '.git');
  try {
    if (!existsSync(dotGit)) return real(repoOrWorktree);
    if (statSync(dotGit).isDirectory()) return real(dotGit);
    const m = /^gitdir:\s*(.+)\s*$/m.exec(readFileSync(dotGit, 'utf-8'));
    if (!m) return real(repoOrWorktree);
    const gitDir = isAbsolute(m[1]) ? m[1] : resolve(repoOrWorktree, m[1]);
    const commonFile = join(gitDir, 'commondir');
    if (existsSync(commonFile)) {
      const rel = readFileSync(commonFile, 'utf-8').trim();
      return real(isAbsolute(rel) ? rel : resolve(gitDir, rel));
    }
    // A `--separate-git-dir` main clone: `.git` is a file pointing straight at
    // the common dir (no `commondir` file), which is also what its worktrees
    // resolve to. Only a linked worktree's gitdir sits in <common>/worktrees/.
    if (basename(dirname(gitDir)) === 'worktrees') return real(dirname(dirname(gitDir)));
    return real(gitDir);
  } catch {
    return real(repoOrWorktree);
  }
}

/**
 * Wait for this repo's lock and return its release. For a holder whose locked
 * part ends partway through a function (worktree setup releases before the
 * dependency install). Release is idempotent.
 */
export async function acquireRepoLock(repoOrWorktree: string): Promise<() => void> {
  const key = gitCommonDirKey(repoOrWorktree);
  const prev = tails.get(key) ?? Promise.resolve();
  let done!: () => void;
  const mine = new Promise<void>((r) => { done = r; });
  const tail = prev.then(() => mine);
  tails.set(key, tail);
  await prev;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    done();
    if (tails.get(key) === tail) tails.delete(key);
  };
}

/** Run `fn` once every earlier holder of this repo's lock has finished. */
export async function withRepoLock<T>(repoOrWorktree: string, fn: () => Promise<T>): Promise<T> {
  const release = await acquireRepoLock(repoOrWorktree);
  try {
    return await fn();
  } finally {
    release();
  }
}
