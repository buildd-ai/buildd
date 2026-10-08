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
 *   - 0 commits ahead of its configured upstream, or
 *   - its tip is reachable from any remote-tracking ref (`refs/remotes/*`), or
 *   - its tip IS the head of a PR on origin (`refs/pull/N/head`, which GitHub
 *     keeps after the PR closes and its branch is deleted).
 * Runner branches are created with their BASE (origin/dev) as upstream, so
 * `[gone]` almost never fires for them; the last three rules carry the load.
 * Never a branch checked out in any worktree, or in `protectedBranches`
 * (owned by a live worker). Commits that exist only in this clone are always
 * kept, at any age — "no remote" alone is not "remote gone".
 *
 * Also drops registrations of `~/.buildd-cbm-seed/*` worktrees left by the
 * removed CBM provisioning.
 */
import { execFileSync } from 'child_process';
import { existsSync, realpathSync, rmSync } from 'fs';
import { homedir } from 'os';
import { join, sep } from 'path';
import { parseWorktreeList } from './worktree-utils';

export const BRANCH_PREFIX = 'buildd/';
export const DEFAULT_MAX_BRANCH_DELETES_PER_TICK = 1000;
export const DEFAULT_MAX_SEED_REMOVALS_PER_TICK = 5;
const LS_REMOTE_TIMEOUT_MS = 20_000;

export interface PruneOptions {
  /** Branches owned by a live worker (never deleted). */
  protectedBranches?: Iterable<string>;
  maxDeletes?: number;
  maxSeedRemovals?: number;
  /** Directory whose worktree registrations are dropped. Default `~/.buildd-cbm-seed`. */
  seedDir?: string;
}

export interface PruneResult {
  branchesPruned: number;
  seedWorktreesRemoved: number;
}

function git(cwd: string, args: string[], extra: { timeout?: number; input?: string } = {}): string {
  return execFileSync('git', args, {
    cwd, encoding: 'utf-8', timeout: extra.timeout ?? 30_000, stdio: 'pipe', maxBuffer: 64 * 1024 * 1024,
    input: extra.input,
    // ls-remote must never block on a credential prompt.
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
}

/** Tips (of `shas`) NOT reachable from any remote-tracking ref, in one rev-list pass. */
function tipsOnlyLocal(repoDir: string, shas: string[]): Set<string> | null {
  if (shas.length === 0) return new Set();
  try {
    const out = git(repoDir, ['rev-list', '--stdin', '--not', '--remotes'], { input: shas.join('\n') + '\n' });
    return new Set(out.split('\n').filter(Boolean));
  } catch {
    return null;
  }
}

/** SHAs of every `refs/pull/N/head` on origin, or null when origin can't be reached. */
function prHeadShas(repoDir: string): Set<string> | null {
  try {
    const out = git(repoDir, ['ls-remote', 'origin', 'refs/pull/*/head'], { timeout: LS_REMOTE_TIMEOUT_MS });
    return new Set(out.split('\n').map(l => l.split('\t')[0]).filter(Boolean));
  } catch {
    return null;
  }
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
  const maxDeletes = opts.maxDeletes ?? DEFAULT_MAX_BRANCH_DELETES_PER_TICK;
  const seedDir = opts.seedDir ?? join(homedir(), '.buildd-cbm-seed');

  let worktrees: { path: string; branch: string | null }[];
  try {
    worktrees = parseWorktreeList(git(repoDir, ['worktree', 'list', '--porcelain']));
  } catch {
    return result;
  }

  // git prints resolved paths, so match the symlink-resolved dir too
  // (macOS tmpdir is /var → /private/var).
  const seedPrefixes = [seedDir];
  try { seedPrefixes.push(realpathSync(seedDir)); } catch { /* not created */ }
  const asPrefix = (d: string) => (d.endsWith(sep) ? d : d + sep);
  const seeds = worktrees.filter(w => seedPrefixes.some(d => w.path.startsWith(asPrefix(d))));
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
      'for-each-ref', '--format=%(refname:short)\t%(objectname)\t%(upstream)\t%(upstream:track)',
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

  // Cheap rules first (no extra git call), then one rev-list pass, then one
  // ls-remote — each only over what the previous rules left.
  const doomed: string[] = [];
  let rest: { name: string; sha: string }[] = [];
  for (const line of refs) {
    const [name, sha, upstream, track = ''] = line.split('\t');
    if (!name || !sha || keep.has(name)) continue;
    const notAhead = !!upstream && !track.includes('ahead') && !track.includes('gone');
    if (merged.has(name) || track.includes('gone') || notAhead) doomed.push(name);
    else rest.push({ name, sha });
  }

  const localOnly = tipsOnlyLocal(repoDir, rest.map(r => r.sha));
  if (localOnly) {
    for (const r of rest) if (!localOnly.has(r.sha)) doomed.push(r.name);
    rest = rest.filter(r => localOnly.has(r.sha));
  }

  if (rest.length > 0 && doomed.length < maxDeletes) {
    const prHeads = prHeadShas(repoDir);
    if (prHeads) for (const r of rest) if (prHeads.has(r.sha)) doomed.push(r.name);
  }
  doomed.splice(maxDeletes);

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
