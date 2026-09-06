/**
 * Git operations for worker sessions — worktree setup/cleanup and stats collection.
 * Extracted from WorkerManager to reduce workers.ts complexity.
 */

import * as cp from 'child_process';
import * as fs from 'fs';
import { join } from 'path';
import { resolveWorktreeBase, clearResumeContext, parseWorktreeList, BranchFetchResult } from './worktree-utils';

// Mutable dep references — tests inject mocks via __setGitOpsDeps() without
// touching bun's mock.module registry (which is shared across parallel workers
// and can be cleared by mock.restore() in sibling test files).
// Production code uses real implementations captured at load time.
// Note: installWorkspaceDeps uses `new Promise` with execFile directly (not
// util.promisify) so mock injection via __setGitOpsDeps works consistently
// across bun versions — util.promisify behaviour varies between 1.3.x releases.
let execSync = cp.execSync;
let execFile: typeof cp.execFile = cp.execFile;
let existsSync = fs.existsSync;
let mkdirSync = fs.mkdirSync;
let appendFileSync = fs.appendFileSync;
let readFileSync = fs.readFileSync;
let rmSync = fs.rmSync;
// Optional spy for cleanupWorktree — set via __setGitOpsDeps to avoid mock.module pollution
let _cleanupSpy: ((repoPath: string, worktreePath: string, workerId: string) => Promise<void>) | null = null;

export interface GitOpsDeps {
  execSync: typeof cp.execSync;
  execFile: typeof cp.execFile;
  existsSync: typeof fs.existsSync;
  mkdirSync: typeof fs.mkdirSync;
  appendFileSync: typeof fs.appendFileSync;
  readFileSync: typeof fs.readFileSync;
  rmSync: typeof fs.rmSync;
  // Optional spy that intercepts cleanupWorktree calls (used by eviction tests)
  cleanupSpy?: ((repoPath: string, worktreePath: string, workerId: string) => Promise<void>) | null;
}

/** Test-only: replace internal dependencies with mocks. */
export function __setGitOpsDeps(mocks: GitOpsDeps): void {
  execSync = mocks.execSync;
  execFile = mocks.execFile;
  existsSync = mocks.existsSync;
  mkdirSync = mocks.mkdirSync;
  appendFileSync = mocks.appendFileSync;
  readFileSync = mocks.readFileSync;
  rmSync = mocks.rmSync;
  if (mocks.cleanupSpy !== undefined) _cleanupSpy = mocks.cleanupSpy;
}

/** Test-only: restore real implementations. */
export function __resetGitOpsDeps(): void {
  execSync = cp.execSync;
  execFile = cp.execFile;
  existsSync = fs.existsSync;
  mkdirSync = fs.mkdirSync;
  appendFileSync = fs.appendFileSync;
  readFileSync = fs.readFileSync;
  rmSync = fs.rmSync;
  _cleanupSpy = null;
}

export interface GitStats {
  commitCount?: number;
  filesChanged?: number;
  linesAdded?: number;
  linesRemoved?: number;
  lastCommitSha?: string;
}

/**
 * Install workspace dependencies into a freshly-created worktree so Bun's nested
 * node_modules symlinks (@buildd/core, @buildd/shared, …) exist locally — without
 * them, deep imports like '@buildd/core/db' fail with "Cannot find module".
 *
 * Runs ASYNCHRONOUSLY (execFile, not execSync): even a warm-cache install takes a
 * few seconds, and a synchronous call would freeze the runner's single event loop
 * for the whole duration — starving heartbeats, the 30s stale-check and the 10s
 * server sync, which can get an active worker wrongly flagged stale.
 *
 * `--frozen-lockfile` keeps the common path fast and deterministic (no re-resolution,
 * no lockfile mutation). If the branch's lockfile has drifted, frozen install fails,
 * so we retry unfrozen — node_modules gets created either way. Both attempts are
 * non-fatal: a total failure only warns (deep @buildd/* imports may then break, and
 * the caller falls back to the main repo).
 */
async function installWorkspaceDeps(worktreePath: string, workerId: string): Promise<void> {
  const opts = { cwd: worktreePath, timeout: 120_000, encoding: 'utf-8' as const };

  // Use new Promise + execFile directly instead of util.promisify so that mock
  // injection via __setGitOpsDeps works consistently across bun versions.
  const run = (args: string[]) => new Promise<void>((resolve, reject) => {
    execFile('bun', args, opts, (err) => { if (err) reject(err); else resolve(); });
  });

  console.log(`[Worker ${workerId}] Running bun install in worktree (frozen lockfile)...`);
  try {
    await run(['install', '--frozen-lockfile']);
    console.log(`[Worker ${workerId}] Workspace packages linked`);
    return;
  } catch (err) {
    console.warn(
      `[Worker ${workerId}] Frozen bun install failed (lockfile may have drifted), retrying unfrozen:`,
      err instanceof Error ? err.message : err,
    );
  }

  try {
    await run(['install']);
    console.log(`[Worker ${workerId}] Workspace packages linked (unfrozen)`);
  } catch (err) {
    console.warn(
      `[Worker ${workerId}] bun install in worktree failed — @buildd/* imports may break:`,
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Map every branch currently checked out in this repo's worktree set (including
 * the main working copy) to the worktree path holding it.
 *
 * Git allows a branch to be checked out by at most ONE worktree, and all role
 * clones are worktrees of a single repo sharing one branch namespace. Knowing
 * who holds what is what lets setupWorktree avoid a guaranteed-fatal
 * `git worktree add -b <held-branch>` and name the holder when it still fails.
 *
 * Best-effort: on any git error we return an empty map (guarding degrades to the
 * old behaviour rather than blocking worktree creation).
 */
function listBranchOwners(
  execOpts: { cwd: string; timeout: number; encoding: 'utf-8' },
): Map<string, string> {
  const owners = new Map<string, string>();
  for (const entry of listWorktreeEntries(execOpts)) {
    if (entry.branch) owners.set(entry.branch, entry.path);
  }
  return owners;
}

/**
 * Every worktree git has registered for this repo (the main working copy
 * included). Best-effort: on any git error we return an empty list, so every
 * guard built on it degrades to the old, unguarded behaviour.
 */
function listWorktreeEntries(
  execOpts: { cwd: string; timeout: number; encoding: 'utf-8' },
): { path: string; branch: string | null }[] {
  try {
    const porcelain = String(
      execSync('git worktree list --porcelain', { ...execOpts, timeout: 5000 }) ?? '',
    );
    return parseWorktreeList(porcelain);
  } catch {
    // No remote/unusual state — treat as "nothing known to be held".
    return [];
  }
}

/**
 * May a REGISTERED worktree at `worktreePath` be reclaimed (deleted) by another
 * worker? Only when its working tree is provably clean.
 *
 * `git worktree remove --force` exits 0 on a worktree with uncommitted changes:
 * it deletes the work and reports success. So this probe is the only thing
 * standing between a worktree-path collision and another live worker losing its
 * edits. An inconclusive probe (timeout, corrupt index, git error) is treated as
 * NOT reclaimable — the cost of being wrong is a second directory, versus
 * destroying work in progress.
 *
 * Callers must only ask about paths git reports as worktrees; a plain leftover
 * directory is not this function's business (it is always removable).
 */
function worktreeIsReclaimable(
  worktreePath: string,
  execOpts: { cwd: string; timeout: number; encoding: 'utf-8' },
): boolean {
  try {
    const status = String(
      execSync('git status --porcelain', { ...execOpts, cwd: worktreePath, timeout: 5000 }) ?? '',
    );
    return status.trim().length === 0;
  } catch {
    return false;
  }
}

/**
 * Set up an isolated git worktree for a worker session.
 * Worktrees live in .buildd-worktrees/ inside the repo.
 */
export interface SetupWorktreeResult {
  /** Absolute path to the worktree directory. */
  path: string;
  /** The git branch checked out in the worktree.
   *  Equals `resumeBranch` when the prior attempt's branch was reused;
   *  equals the task's own `branch` parameter otherwise.  The caller should
   *  update `worker.branch` with this value so pushes target the right ref. */
  branch: string;
  /**
   * The ref the worktree was actually cut from, e.g. `origin/main` or a mission
   * integration branch. RESOLVED, not predicted: it is whatever
   * resolveWorktreeBase settled on after probing the remote, including any
   * fallback it took.
   *
   * Returned because the codebase-memory seed is keyed on it. A caller that
   * re-derived this instead would be re-implementing the base decision, and
   * branch-names.ts documents what hand-mirroring that rule already cost once —
   * a predicted ref that never existed, failing silently.
   */
  base: string;
  /** Set when resume candidate was requested but not usable (missing/diverged),
   *  causing a fresh start from the default branch.  Callers should surface
   *  this as a visible warning rather than silently degrading. */
  fallback?: { candidate: string; reason: 'missing' | 'diverged' };
  /** Set when a resume/base candidate resolved to a branch that cannot be the
   *  worktree's own checkout — the repo default branch, or a branch another
   *  worktree already holds. The task's own `branch` was used instead, so the
   *  worker keeps its isolated worktree (and CBM) instead of failing setup and
   *  degrading into the shared repo root. `holder` is the worktree that owns the
   *  branch, when known. */
  sharedBranch?: {
    candidate: string;
    reason: 'default_branch' | 'checked_out';
    holder?: string;
  };
}

export async function setupWorktree(
  repoPath: string,
  branch: string,
  defaultBranch: string,
  workerId: string,
  taskContext?: Record<string, unknown>,
): Promise<SetupWorktreeResult | null> {
  const execOpts = { cwd: repoPath, timeout: 30000, encoding: 'utf-8' as const };

  // Worktrees live in .buildd-worktrees/ inside the repo
  const worktreeBase = join(repoPath, '.buildd-worktrees');
  const safeBranch = branch.replace(/[^a-zA-Z0-9_-]/g, '_');
  // Keyed on the REQUESTED branch, so two workers asking for the same branch
  // (a mission carrying a stable `headBranch`, a shared base) compute the same
  // directory even though the shared-branch guard below gives them distinct
  // branches. Reassigned below when that path turns out to be occupied by a
  // worktree with live, uncommitted work.
  let worktreePath = join(worktreeBase, safeBranch);

  try {
    // Ensure worktree base directory exists
    mkdirSync(worktreeBase, { recursive: true });

    // Add .buildd-worktrees to .git/info/exclude if not already there
    const excludePath = join(repoPath, '.git', 'info', 'exclude');
    if (existsSync(excludePath)) {
      const excludeContent = readFileSync(excludePath, 'utf-8');
      if (!excludeContent.includes('.buildd-worktrees')) {
        appendFileSync(excludePath, '\n.buildd-worktrees\n');
      }
    }

    // Fetch latest from remote
    console.log(`[Worker ${workerId}] Fetching latest from remote...`);
    try {
      execSync('git fetch origin', execOpts);
    } catch (err) {
      console.warn(`[Worker ${workerId}] git fetch failed (continuing with local state):`, err instanceof Error ? err.message : err);
    }

    // Clean up stale worktree at this path if it exists.
    //
    // "Stale" is an assumption, and it used to be unchecked: `git worktree
    // remove --force` exits 0 on a worktree with uncommitted changes, so a
    // second worker whose requested branch produced the same directory would
    // silently delete the first worker's in-progress work and report success.
    // Only reclaim a path that is either not a registered worktree at all
    // (plain leftover directory) or registered with a clean tree. Otherwise
    // leave it to its owner and take a worker-scoped path instead — unique per
    // attempt by construction, the same escape the branch ladder below uses.
    if (existsSync(worktreePath)) {
      const registered = listWorktreeEntries(execOpts).some(e => e.path === worktreePath);
      if (registered && !worktreeIsReclaimable(worktreePath, execOpts)) {
        const diverted = `${worktreePath}-w${workerId.slice(0, 8)}`;
        console.warn(
          `[Worker ${workerId}] Worktree path ${worktreePath} is a registered worktree that is ` +
          `not provably clean — refusing to force-remove it (that deletes another worker's ` +
          `uncommitted work and still exits 0). Using ${diverted} instead.`,
        );
        worktreePath = diverted;
        if (existsSync(worktreePath)) {
          // Our own leftover from a previous attempt with this worker id.
          try {
            execSync(`git worktree remove --force "${worktreePath}"`, execOpts);
          } catch {
            rmSync(worktreePath, { recursive: true, force: true });
            try { execSync('git worktree prune', execOpts); } catch {}
          }
        }
      } else {
        console.log(`[Worker ${workerId}] Cleaning up stale worktree at ${worktreePath}`);
        try {
          execSync(`git worktree remove --force "${worktreePath}"`, execOpts);
        } catch {
          // Force-remove the directory if git worktree remove fails
          rmSync(worktreePath, { recursive: true, force: true });
          try { execSync('git worktree prune', execOpts); } catch {}
        }
      }
    }

    // Determine if there is a resume candidate from prior attempt context.
    // Prefer resumeBranch (new canonical field) over baseBranch (legacy CI retry).
    const resumeCandidate =
      (typeof taskContext?.resumeBranch === 'string' && taskContext.resumeBranch.length > 0
        ? taskContext.resumeBranch as string
        : undefined) ??
      (typeof taskContext?.baseBranch === 'string' && (taskContext.baseBranch as string).length > 0
        ? taskContext.baseBranch as string
        : undefined);

    // Warn if parent repo has sparse checkout enabled. Git worktrees get their
    // own sparse-checkout config so this doesn't directly affect the worktree,
    // but it's worth logging so the pattern is visible if issues recur.
    try {
      const sparsePatterns = execSync('git sparse-checkout list', { ...execOpts, timeout: 5000 }).trim();
      if (sparsePatterns) {
        console.warn(
          `[Worker ${workerId}] Parent repo has sparse checkout enabled. ` +
          `Worktrees are always fully checked out, but if @buildd/* imports still fail, ` +
          `run: cd "${repoPath}" && git sparse-checkout disable && bun install`,
        );
      }
    } catch {
      // Non-zero exit means sparse checkout is not configured — normal state.
    }

    // Create worktree with new branch — from resumeBranch/baseBranch (retry) or default branch (fresh)
    // fetchBranch uses already-fetched remote tracking refs (git fetch origin ran above)
    const fetchBranch = async (candidate: string): Promise<BranchFetchResult> => {
      try {
        const countStr = execSync(
          `git rev-list --count "origin/${defaultBranch}..origin/${candidate}"`,
          { ...execOpts, timeout: 10000 },
        ).trim();
        const count = parseInt(countStr, 10);
        if (!isNaN(count) && count > 50) {
          return 'diverged';
        }
        return 'ok';
      } catch {
        // Command fails when origin/<candidate> ref doesn't exist
        return 'missing';
      }
    };
    let fallback: SetupWorktreeResult['fallback'];
    const base = await resolveWorktreeBase({
      defaultBranch,
      context: taskContext,
      fetchBranch,
      log: (msg) => console.log(`[Worker ${workerId}] ${msg}`),
      // The resume branch is gone/diverged and we fell back to the default base —
      // strip the stale resume fields so the session starts fresh instead of
      // building "prior attempt" instructions that reference a missing branch.
      onFallback: (info) => {
        fallback = info;
        clearResumeContext(taskContext);
      },
    });

    // Stale-base guard: warn when the ref this task will build on has fallen
    // significantly behind the default branch. Agents starting on a stale base
    // risk merge conflicts or CI failures caused by unrelated upstream changes.
    //
    // It must measure `base` — the ref the worktree is cut from. It used to run
    // `HEAD..origin/<default>` under `cwd: repoPath`, i.e. the MAIN CLONE's
    // HEAD: not this worktree (which does not exist yet) and not the branch the
    // task will work on. That is an unrelated tree, so the number it printed
    // described nothing about this task. A task cut straight from the default
    // branch now measures zero and stays quiet, which is correct.
    //
    // Non-blocking and advisory, deliberately: it never changes the base, never
    // fails setup, and the log line names the ref it measured so a wrong-tree
    // measurement is visible next time instead of inferred.
    try {
      const behindStr = execSync(
        `git rev-list --count "${base}..origin/${defaultBranch}"`,
        { ...execOpts, timeout: 5000 },
      ).trim();
      const commitsBehind = parseInt(behindStr, 10);
      if (!isNaN(commitsBehind) && commitsBehind > 10) {
        console.warn(
          `[Worker ${workerId}] ⚠ Stale-base warning: the base ref "${base}" this worktree is ` +
          `cut from is ${commitsBehind} commits behind origin/${defaultBranch}. ` +
          `Consider running: git fetch origin && git rebase origin/${defaultBranch} before pushing. ` +
          `Past CI retry chains were caused by this kind of staleness.`,
        );
      }
    } catch {
      // Non-fatal: git rev-list can fail for repos with no remote or when the
      // base ref is not yet a local remote-tracking ref.
    }

    // When the resume candidate was usable (no fallback), check out THAT branch
    // directly so the worker pushes to the existing PR's branch rather than
    // opening a new branch/PR.  On fallback, use the task's own branch (fresh).
    const requestedBranch =
      resumeCandidate && !fallback && base === `origin/${resumeCandidate}`
        ? resumeCandidate
        : branch;

    // Which branches are already checked out somewhere in this repo? Computed
    // AFTER the stale-worktree cleanup above so a path we just reclaimed isn't
    // counted as a holder.
    const branchOwners = listBranchOwners(execOpts);

    // Mission-integration guard: a task must NEVER work directly on the mission
    // integration branch. When context.baseBranch is a mission integration branch
    // and the task's branch parameter is also that same branch (a bug in task
    // creation), the branch should have been cut FROM the base, not BE the base.
    //
    // Detect: the ORIGINAL branch parameter equals the base ref (stripped of "origin/" prefix).
    // This is different from the resume case: when resuming, requestedBranch is set to
    // resumeCandidate (a prior branch to update), not the original branch parameter.
    // We only guard when branch (the parameter) itself equals the base (integration branch).
    const baseWithoutPrefix = base.replace(/^origin\//, '');
    const branchEqualsBase = branch === baseWithoutPrefix;

    // Shared-branch guard.  A worktree cannot be checked out onto the repo
    // default branch (the main clone holds it) nor onto a branch another
    // worktree already holds — git fails with "a branch named 'X' already
    // exists" / "cannot delete branch 'X' used by worktree at …".  Tasks whose
    // context carried baseBranch:"dev" used to hit exactly that: every
    // concurrent worker but one failed setup and was silently degraded into the
    // shared role-clone root (no fs isolation, no CBM).  Fall back to the task's
    // own branch, which is unique per task, and report it.
    //
    // This also covers the mission-integration case: when the branch parameter
    // equals the base branch (not just requestedBranch), it's a bug and the guard fires.
    /** Why a branch cannot be the checkout target of a new worktree, if it cannot. */
    const unusable = (candidate: string): 'default_branch' | 'checked_out' | null =>
      candidate === defaultBranch
        ? 'default_branch'
        : branchOwners.has(candidate)
          ? 'checked_out'
          : branchEqualsBase && candidate === baseWithoutPrefix
            ? 'default_branch' // Use 'default_branch' reason for the base branch too — shared namespace
            : null;

    // Candidates in preference order. The task branch is NOT automatically a
    // safe fallback: it can itself be held (a mission carries a stable
    // `headBranch` across cycles, so two concurrent workers in one mission ask
    // for the same branch) or, for a task cut against the default branch, be the
    // default branch. Gating the guard on `requestedBranch !== branch` left both
    // holes open — the same collision, one door along. The last candidate embeds
    // the worker id, so it is unique per attempt by construction.
    const uniqueBranch = `${branch}-w${workerId.slice(0, 8)}`;
    const candidates = [...new Set([requestedBranch, branch, uniqueBranch])];

    let actualBranch = candidates[candidates.length - 1];
    let sharedBranch: SetupWorktreeResult['sharedBranch'];
    for (const candidate of candidates) {
      const reason = unusable(candidate);
      if (!reason) { actualBranch = candidate; break; }
      // Report the FIRST rejection: that is the branch the caller asked for and
      // the one whose absence changes where pushes land.
      if (!sharedBranch) {
        const holder = branchOwners.get(candidate);
        sharedBranch = { candidate, reason, ...(holder ? { holder } : {}) };
      }
    }

    if (sharedBranch) {
      const { candidate, reason, holder } = sharedBranch;
      console.warn(
        `[Worker ${workerId}] Cannot check out "${candidate}" in a worktree ` +
        (reason === 'default_branch'
          ? `— it is the repo default branch (held by the main checkout${holder ? ` at ${holder}` : ''}). `
          : `— it is already checked out in worktree ${holder}. `) +
        `Using "${actualBranch}" instead (base stays ${base}). ` +
        `Pushes will target "${actualBranch}", so a new PR may be opened instead of updating an existing one.`,
      );
    }

    console.log(`[Worker ${workerId}] Creating worktree: ${worktreePath} (branch: ${actualBranch}, base: ${base})`);

    // Delete stale local branches from a previous run. Skip any branch a live
    // worktree holds — `git branch -D` on those always fails, and the resulting
    // "cannot delete branch 'X' used by worktree" noise used to be the first
    // symptom of this whole class of bug.
    for (const candidate of candidates) {
      if (branchOwners.has(candidate)) continue;
      try {
        execSync(`git branch -D "${candidate}"`, execOpts);
      } catch {
        // Branch doesn't exist locally — that's fine
      }
    }

    try {
      execSync(`git worktree add -b "${actualBranch}" "${worktreePath}" "${base}"`, execOpts);
    } catch (err) {
      // Make the failure legible: name the branch and, when the branch namespace
      // is the cause, the worktree that holds it. Re-probe rather than trusting
      // the pre-flight map — another worker may have taken the branch in between.
      const holder = listBranchOwners(execOpts).get(actualBranch) ?? branchOwners.get(actualBranch);
      const detail = holder
        ? `branch "${actualBranch}" is already checked out in worktree ${holder}`
        : `branch "${actualBranch}" could not be created at ${worktreePath}`;
      throw new Error(
        `git worktree add failed: ${detail} (base ${base}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Register the repo's shared git hooks in this worktree. The package.json
    // `prepare` script also sets this during `bun install`, but that install is
    // best-effort (see installWorkspaceDeps) — doing it explicitly here guarantees
    // commit-time gates (e.g. spec lint) fire even if install never runs. Guarded
    // on .githooks existing so other repos the runner clones are unaffected.
    if (existsSync(join(worktreePath, '.githooks'))) {
      try {
        execSync('git config core.hooksPath .githooks', { ...execOpts, cwd: worktreePath });
        console.log(`[Worker ${workerId}] Registered .githooks (core.hooksPath)`);
      } catch (err) {
        console.warn(`[Worker ${workerId}] Failed to register .githooks:`, err instanceof Error ? err.message : err);
      }
    }

    // Wire up workspace package symlinks (@buildd/core, @buildd/shared, etc.).
    // Bun places these in nested node_modules (e.g. apps/web/node_modules/@buildd/core)
    // rather than the workspace root. A fresh worktree has no node_modules at all, so
    // module resolution from the worktree tree never finds the symlinks that exist in the
    // parent repo — causing '@buildd/core/db' (and similar deep imports) to fail with
    // "Cannot find module". Running bun install creates the links in-place.
    await installWorkspaceDeps(worktreePath, workerId);

    console.log(`[Worker ${workerId}] Worktree ready at ${worktreePath}`);
    return {
      path: worktreePath,
      branch: actualBranch,
      base,
      ...(fallback ? { fallback } : {}),
      ...(sharedBranch ? { sharedBranch } : {}),
    };
  } catch (err) {
    console.error(`[Worker ${workerId}] Failed to set up worktree:`, err instanceof Error ? err.message : err);
    // Clean up partial worktree
    try {
      if (existsSync(worktreePath)) {
        rmSync(worktreePath, { recursive: true, force: true });
      }
      execSync('git worktree prune', { ...execOpts, timeout: 5000 });
    } catch {}
    return null;
  }
}

/**
 * Clean up a git worktree after worker completes.
 * Removes the worktree directory and prunes git worktree metadata.
 */
export async function cleanupWorktree(repoPath: string, worktreePath: string, workerId: string) {
  if (_cleanupSpy) return _cleanupSpy(repoPath, worktreePath, workerId);
  const execOpts = { cwd: repoPath, timeout: 10000, encoding: 'utf-8' as const };

  try {
    console.log(`[Worker ${workerId}] Removing worktree: ${worktreePath}`);
    execSync(`git worktree remove --force "${worktreePath}"`, execOpts);
  } catch (err) {
    console.warn(`[Worker ${workerId}] git worktree remove failed, cleaning up manually:`, err instanceof Error ? err.message : err);
    try {
      rmSync(worktreePath, { recursive: true, force: true });
      execSync('git worktree prune', execOpts);
    } catch {}
  }
}

/**
 * Collect git stats (commits, files changed, lines added/removed) from a working directory.
 * @param cwd - The working directory to collect stats from
 * @param workerId - For logging
 * @param fallbackCommitCount - Fallback count if git rev-list fails (e.g. from worker.commits.length)
 */
export async function collectGitStats(
  cwd: string | undefined,
  workerId: string,
  fallbackCommitCount?: number,
): Promise<GitStats> {
  if (!cwd) return {};

  const opts = { cwd, timeout: 5000, encoding: 'utf-8' as const };
  const stats: Record<string, number | string | undefined> = {};

  try {
    stats.lastCommitSha = execSync('git rev-parse HEAD', opts).trim();
  } catch {}
  try {
    // Count commits on this branch vs default branch
    const defaultBranch = execSync('git rev-parse --abbrev-ref HEAD@{upstream}', opts).trim().replace(/^origin\//, '') || 'main';
    const count = execSync(`git rev-list --count HEAD ^origin/${defaultBranch}`, opts).trim();
    stats.commitCount = parseInt(count, 10) || 0;
  } catch {
    // Fallback: use locally tracked commits
    if (fallbackCommitCount !== undefined) stats.commitCount = fallbackCommitCount;
  }
  try {
    // Compute full PR diff: find the merge-base with the base branch so we capture all
    // commits on this branch, not just the last commit (HEAD~1 only shows the final commit).
    // Try branch candidates in order; the first one that yields a merge-base wins.
    let mergeBase = '';
    for (const candidate of ['origin/dev', 'origin/main', 'origin/master']) {
      try {
        const result = execSync(`git merge-base HEAD ${candidate} 2>/dev/null`, opts).trim();
        if (result) { mergeBase = result; break; }
      } catch {}
    }
    const diffTarget = mergeBase || 'HEAD~1';
    const numstat = execSync(`git diff --numstat ${diffTarget} 2>/dev/null || true`, opts).trim();
    if (numstat) {
      let added = 0, removed = 0, files = 0;
      for (const line of numstat.split('\n')) {
        const [a, r] = line.split('\t');
        if (a !== '-') { added += parseInt(a, 10) || 0; removed += parseInt(r, 10) || 0; files++; }
      }
      stats.filesChanged = files;
      stats.linesAdded = added;
      stats.linesRemoved = removed;
    }
  } catch {}

  return stats;
}
