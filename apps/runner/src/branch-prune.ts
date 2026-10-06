/**
 * Prune the local `buildd/*` branches the runner creates per worker.
 *
 * Nothing deletes them (only reuse does), so a long-lived shared clone
 * accumulates thousands, each with a `[branch]` section in `.git/config`.
 * Every worktree shares that file and every `git config` / `worktree add` /
 * `push -u` rewrites it whole under a lock, so a bloated config makes parallel
 * worker starts lose the lock race. `git branch -D` removes the ref and the
 * section together.
 *
 * A branch is dropped only when its work is safe to lose:
 *   - merged into the default branch, or
 *   - its upstream is `[gone]` (it was pushed, the remote branch was deleted), or
 *   - older than `maxAgeMs` while its remote-tracking ref still holds the tip.
 * Never a branch checked out in any worktree, or in `protectedBranches`
 * (owned by a live worker). A branch that was never pushed and is unmerged is
 * always kept — "no remote" alone is not "remote gone".
 *
 * Also drops registrations of `~/.buildd-cbm-seed/*` worktrees left by the
 * removed CBM provisioning.
 */
import { execFileSync } from 'child_process';
import { existsSync, rmSync } from 'fs';
import { homedir } from 'os';
import { join, sep } from 'path';
import { parseWorktreeList } from './worktree-utils';

export const BRANCH_PREFIX = 'buildd/';
export const DEFAULT_BRANCH_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
export const DEFAULT_MAX_BRANCH_DELETES_PER_TICK = 200;
export const DEFAULT_MAX_SEED_REMOVALS_PER_TICK = 5;

export interface PruneOptions {
  /** Branches owned by a live worker (never deleted). */
  protectedBranches?: Iterable<string>;
  maxAgeMs?: number;
  maxDeletes?: number;
  maxSeedRemovals?: number;
  /** Directory whose worktree registrations are dropped. Default `~/.buildd-cbm-seed`. */
  seedDir?: string;
  now?: number;
}

export interface PruneResult {
  branchesPruned: number;
  seedWorktreesRemoved: number;
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd, encoding: 'utf-8', timeout: 30_000, stdio: 'pipe', maxBuffer: 64 * 1024 * 1024,
  });
}

function defaultRef(repoDir: string): string | null {
  const candidates: string[] = [];
  try { candidates.push(git(repoDir, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).trim()); } catch { /* none */ }
  candidates.push('origin/dev', 'origin/main', 'origin/master');
  for (const c of candidates) {
    try { git(repoDir, ['rev-parse', '--verify', '--quiet', `refs/remotes/${c}`]); return c; } catch { /* next */ }
  }
  return null;
}

export function pruneLocalBranches(repoDir: string, opts: PruneOptions = {}): PruneResult {
  const result: PruneResult = { branchesPruned: 0, seedWorktreesRemoved: 0 };
  const now = opts.now ?? Date.now();
  const maxAgeMs = opts.maxAgeMs ?? DEFAULT_BRANCH_MAX_AGE_MS;
  const maxDeletes = opts.maxDeletes ?? DEFAULT_MAX_BRANCH_DELETES_PER_TICK;
  const seedDir = opts.seedDir ?? join(homedir(), '.buildd-cbm-seed');

  let worktrees: { path: string; branch: string | null }[];
  try {
    worktrees = parseWorktreeList(git(repoDir, ['worktree', 'list', '--porcelain']));
  } catch {
    return result;
  }

  const seedPrefix = seedDir.endsWith(sep) ? seedDir : seedDir + sep;
  const seeds = worktrees.filter(w => w.path.startsWith(seedPrefix));
  const removedSeeds = new Set<string>();
  for (const w of seeds.slice(0, opts.maxSeedRemovals ?? DEFAULT_MAX_SEED_REMOVALS_PER_TICK)) {
    try {
      git(repoDir, ['worktree', 'remove', '--force', w.path]);
    } catch {
      try { rmSync(w.path, { recursive: true, force: true }); } catch { /* best effort */ }
    }
    removedSeeds.add(w.path);
    result.seedWorktreesRemoved++;
  }
  // Covers the rm fallback and registrations whose directory is already gone.
  if (seeds.length > 0 || worktrees.some(w => !existsSync(w.path))) {
    try { git(repoDir, ['worktree', 'prune']); } catch { /* best effort */ }
  }

  const keep = new Set<string>(opts.protectedBranches ?? []);
  // Seed worktrees still registered (over the per-tick cap) keep their branch.
  for (const w of worktrees) if (w.branch && !removedSeeds.has(w.path)) keep.add(w.branch);

  let refs: string[];
  try {
    refs = git(repoDir, [
      'for-each-ref', '--format=%(refname:short)\t%(objectname)\t%(committerdate:unix)\t%(upstream:track)',
      `refs/heads/${BRANCH_PREFIX}`,
    ]).split('\n').filter(Boolean);
  } catch {
    return result;
  }
  if (refs.length === 0) return result;

  const base = defaultRef(repoDir);
  const merged = new Set<string>();
  if (base) {
    try {
      for (const l of git(repoDir, ['branch', '--merged', base, '--format=%(refname:short)', '--list', `${BRANCH_PREFIX}*`]).split('\n')) {
        if (l.trim()) merged.add(l.trim());
      }
    } catch { /* treat as none merged */ }
  }

  const doomed: string[] = [];
  for (const line of refs) {
    if (doomed.length >= maxDeletes) break;
    const [name, sha, ts, track] = line.split('\t');
    if (!name || keep.has(name)) continue;
    let safe = merged.has(name) || (track ?? '').includes('gone');
    if (!safe && now - Number(ts) * 1000 > maxAgeMs) {
      // Old: only if the remote still holds the commits.
      try {
        git(repoDir, ['merge-base', '--is-ancestor', sha, `refs/remotes/origin/${name}`]);
        safe = true;
      } catch { /* remote missing or lacks the tip: keep */ }
    }
    if (safe) doomed.push(name);
  }

  for (let i = 0; i < doomed.length; i += 50) {
    const batch = doomed.slice(i, i + 50);
    try {
      git(repoDir, ['branch', '-D', ...batch]);
      result.branchesPruned += batch.length;
    } catch {
      // One failure (e.g. a lock) must not abort the batch: retry singly.
      for (const b of batch) {
        try { git(repoDir, ['branch', '-D', b]); result.branchesPruned++; } catch { /* next tick */ }
      }
    }
  }
  return result;
}
