/**
 * Git operations for worker sessions — worktree setup/cleanup and stats collection.
 * Extracted from WorkerManager to reduce workers.ts complexity.
 */

import * as cp from 'child_process';
import * as fs from 'fs';
import { join } from 'path';
import {
  resolveWorktreeBase,
  clearResumeContext,
  parseWorktreeList,
  isWorktreePathOwnedByOtherLiveWorker,
  type BranchFetchResult,
  type WorktreeOwnershipRecord,
} from './worktree-utils';
import { sessionLog as realSessionLog } from './session-logger';
import { isGeneratedPath } from '@buildd/shared';
import { detectInstallPlans, resolveManifest, MANIFEST_PATH } from './env-verify';
import { looksLikeMissionIntegrationBranch } from '@buildd/core/mission-integration';

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
// Used only by the install-plan probe (which directories under the worktree
// hold a manifest). Injectable so that test drives the detector without a
// temp-dir fixture.
let readdirSync = fs.readdirSync;
// Injected so unit tests do not append to the host's ~/.buildd/logs while
// exercising the removal guard.
let sessionLog: typeof realSessionLog = realSessionLog;
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
  /** Optional: drive the install-plan directory walk without a temp dir. */
  readdirSync?: typeof fs.readdirSync;
  /** Optional: keep session-log writes out of the host log dir in tests. */
  sessionLog?: typeof realSessionLog;
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
  readdirSync = mocks.readdirSync ?? fs.readdirSync;
  sessionLog = mocks.sessionLog ?? realSessionLog;
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
  readdirSync = fs.readdirSync;
  sessionLog = realSessionLog;
  _cleanupSpy = null;
}

export interface GitStats {
  commitCount?: number;
  filesChanged?: number;
  linesAdded?: number;
  linesRemoved?: number;
  lastCommitSha?: string;
  /** `git status --porcelain` (tracked files only — untracked `??` entries
   *  excluded) found something at collection time. */
  dirtyWorktree?: boolean;
}

/** Why an install failed, in the terms a caller can act on. */
export type InstallFailureClass =
  | 'no-manifest'
  | 'registry-auth'
  | 'toolchain-missing'
  | 'lockfile-drift'
  | 'timeout'
  | 'unknown';

/** The outcome of the runner's own dependency install for a worktree. */
export type InstallOutcome =
  | { status: 'ok'; dirs: string[]; unfrozen?: boolean }
  | { status: 'skipped'; reason: 'no-manifest' | 'non-bun-toolchain' | 'declared-manifest' }
  | { status: 'failed'; dir: string; failure: InstallFailureClass; message: string };

const errMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Classify a failed `bun install` from its output.
 *
 * This exists so the unfrozen retry stops firing blind. Measured: the retry
 * rescued roughly one failure in a hundred and never a non-drift one, while on
 * a registry 401 it doubled the stall and then reported "lockfile may have
 * drifted" — the wrong cause, attributed to the wrong owner.
 */
export function classifyInstallFailure(err: unknown): InstallFailureClass {
  const text = errMessage(err).toLowerCase();
  if (/\b(401|403)\b|unauthorized|forbidden|authentication|incorrect or missing password/.test(text)) {
    return 'registry-auth';
  }
  if (/enoent|command not found|no such file or directory|not found in \$path/.test(text)) {
    return 'toolchain-missing';
  }
  if (/etimedout|timed out|timeout/.test(text)) return 'timeout';
  // Deliberately NOT matching the bare flag name `--frozen-lockfile`: every
  // failure of the frozen attempt echoes the command line, so that pattern
  // classifies *anything* as drift — which is the same misattribution the old
  // "lockfile may have drifted" warning made, one layer down. Only a message
  // that says the lockfile itself was rejected counts.
  if (/lockfile had changes|lockfile is frozen|lockfile is outdated|outdated_lockfile|lockfile needs to be updated|lockfile would be (modified|updated)/.test(text)) {
    return 'lockfile-drift';
  }
  return 'unknown';
}

/**
 * Install dependencies into a freshly-created worktree so Bun's nested
 * node_modules symlinks (@buildd/core, @buildd/shared, …) exist locally —
 * without them, deep imports like '@buildd/core/db' fail with "Cannot find
 * module".
 *
 * Runs ASYNCHRONOUSLY (execFile, not execSync): even a warm-cache install takes
 * a few seconds, and a synchronous call would freeze the runner's single event
 * loop for the whole duration — starving heartbeats, the 30s stale-check and the
 * 10s server sync, which can get an active worker wrongly flagged stale.
 *
 * WHERE it installs is now detected rather than assumed. It used to hardcode
 * `cwd: worktreePath`, so a repo whose manifest lives in a subdirectory failed
 * every time with "Bun could not find a package.json file to install from" —
 * and, because the return type was `void`, nobody found out.
 *
 * Stays BUN-ONLY for the auto-detected path: it exists to create bun's nested
 * workspace symlinks. Having worktree setup start running `npm ci`/`cargo
 * fetch`/`go mod download` for every clone is a different feature with a
 * different risk profile. A non-bun lockfile yields
 * `{status:'skipped', reason:'non-bun-toolchain'}` — honest, and recorded. Repos
 * that need it declare `.buildd/env.yaml` and the provision gate owns it.
 */
async function installWorkspaceDeps(worktreePath: string, workerId: string): Promise<InstallOutcome> {
  const plans = detectInstallPlans(worktreePath, {
    exists: (rel) => existsSync(join(worktreePath, rel)),
    listDirs: (rel) => {
      try {
        return readdirSync(join(worktreePath, rel), { withFileTypes: true })
          .filter(e => e.isDirectory())
          .map(e => e.name);
      } catch {
        return [];
      }
    },
  });

  if (plans.length === 0) {
    // NOT a degradation: a tree with no manifest has no dependencies to break.
    // This is the population that used to invoke bun anyway and then blame the
    // lockfile for a missing package.json.
    console.log(`[Worker ${workerId}] No package manifest in worktree — skipping install`);
    return { status: 'skipped', reason: 'no-manifest' };
  }

  const bunPlans = plans.filter(p => p.runtime === 'bun');
  if (bunPlans.length === 0) {
    console.log(
      `[Worker ${workerId}] Worktree uses a non-bun toolchain (${plans.map(p => p.runtime).join(', ')}) ` +
      `— skipping install; declare ${MANIFEST_PATH} to have the provision gate run it`,
    );
    return { status: 'skipped', reason: 'non-bun-toolchain' };
  }

  const dirs: string[] = [];
  let usedUnfrozen = false;

  for (const plan of bunPlans) {
    const cwd = plan.dir === '.' ? worktreePath : join(worktreePath, plan.dir);
    const opts = { cwd, timeout: 120_000, encoding: 'utf-8' as const };
    // new Promise + execFile directly rather than util.promisify, so mock
    // injection via __setGitOpsDeps works consistently across bun versions.
    const run = (args: string[]) => new Promise<void>((resolve, reject) => {
      execFile('bun', args, opts, (err) => { if (err) reject(err); else resolve(); });
    });

    console.log(`[Worker ${workerId}] Running bun install in ${plan.dir} (frozen lockfile)...`);
    try {
      await run(['install', '--frozen-lockfile']);
      dirs.push(plan.dir);
      continue;
    } catch (err) {
      const failure = classifyInstallFailure(err);
      if (failure !== 'lockfile-drift') {
        console.warn(
          `[Worker ${workerId}] bun install in ${plan.dir} failed (${failure}): ${errMessage(err)}`,
        );
        return { status: 'failed', dir: plan.dir, failure, message: errMessage(err) };
      }
      console.warn(
        `[Worker ${workerId}] Frozen bun install in ${plan.dir} rejected the lockfile, retrying unfrozen: ${errMessage(err)}`,
      );
    }

    try {
      await run(['install']);
      dirs.push(plan.dir);
      usedUnfrozen = true;
    } catch (err) {
      const failure = classifyInstallFailure(err);
      console.warn(
        `[Worker ${workerId}] Unfrozen bun install in ${plan.dir} failed (${failure}): ${errMessage(err)}`,
      );
      return { status: 'failed', dir: plan.dir, failure, message: errMessage(err) };
    }
  }

  console.log(`[Worker ${workerId}] Workspace packages linked in: ${dirs.join(', ')}`);
  return { status: 'ok', dirs, ...(usedUnfrozen ? { unfrozen: true } : {}) };
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
  /**
   * What the runner's own dependency install did. Previously `void`: install
   * failed silently at the wrong path and workers finished `done` with broken
   * workspace imports. The caller must inspect this — see the surfacing block
   * in workers.ts next to the `fallback` handling.
   */
  install: InstallOutcome;
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
    reason: 'default_branch' | 'checked_out' | 'mission_branch';
    holder?: string;
  };
}

/** Branch name → directory name. The only place this mapping is spelled. */
function safeWorktreeDirName(branch: string): string {
  return branch.replace(/[^a-zA-Z0-9_-]/g, '_');
}

export async function setupWorktree(
  repoPath: string,
  branch: string,
  defaultBranch: string,
  workerId: string,
  taskContext?: Record<string, unknown>,
  /**
   * Live-worker view, for the ownership guard on path reclaim. Omit and the
   * guard degrades to the clean-tree probe alone (CLI / doctor callers, which
   * have no in-memory map).
   */
  liveWorkers?: Iterable<[string, WorktreeOwnershipRecord]>,
): Promise<SetupWorktreeResult | null> {
  const execOpts = { cwd: repoPath, timeout: 30000, encoding: 'utf-8' as const };

  // Worktrees live in .buildd-worktrees/ inside the repo
  const worktreeBase = join(repoPath, '.buildd-worktrees');
  const safeBranch = safeWorktreeDirName(branch);
  // Keyed on the REQUESTED branch, so two workers asking for the same branch
  // (a mission carrying a stable `headBranch`, a shared base) compute the same
  // directory even though the shared-branch guard below gives them distinct
  // branches. Recomputed from the RESOLVED branch after the candidate ladder
  // below, which is what closes that collision at the source; also reassigned
  // when this path turns out to be occupied.
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
    /**
     * Free `candidate` for our own use, or return a worker-scoped path to use
     * instead. The single place this decision is made — P4 below reuses it for
     * the post-ladder path so the recompute cannot reintroduce an unguarded
     * force-remove one line further down.
     */
    const reclaimOrDivert = (candidate: string): string => {
      if (!existsSync(candidate)) return candidate;
      const registered = listWorktreeEntries(execOpts).some(e => e.path === candidate);
      // Ownership FIRST: a live worker that has committed its work reads clean,
      // so worktreeIsReclaimable() alone happily deletes an active session's cwd.
      const ownedByLive = liveWorkers
        ? isWorktreePathOwnedByOtherLiveWorker(liveWorkers, candidate, workerId)
        : false;
      if (ownedByLive || (registered && !worktreeIsReclaimable(candidate, execOpts))) {
        const diverted = `${candidate}-w${workerId.slice(0, 8)}`;
        const why = ownedByLive
          ? 'owned by another live worker'
          : 'a registered worktree that is not provably clean';
        console.warn(
          `[Worker ${workerId}] Worktree path ${candidate} is ${why} — refusing to force-remove ` +
          `it (that deletes another worker's work and still exits 0). Using ${diverted} instead.`,
        );
        sessionLog(workerId, 'warn', 'worktree_removal_skipped_owned',
          `Diverted to ${diverted}: ${candidate} is ${why}`);
        if (existsSync(diverted)) {
          // Scoped to our own worker id, so any leftover here is our own from a
          // previous attempt. Still recursed through this same guard rather than
          // force-removed inline.
          return reclaimOrDivert(diverted);
        }
        return diverted;
      }
      console.log(`[Worker ${workerId}] Cleaning up stale worktree at ${candidate}`);
      try {
        execSync(`git worktree remove --force "${candidate}"`, execOpts);
      } catch {
        // Force-remove the directory if git worktree remove fails
        rmSync(candidate, { recursive: true, force: true });
        try { execSync('git worktree prune', execOpts); } catch {}
      }
      return candidate;
    };

    worktreePath = reclaimOrDivert(worktreePath);

    // Determine if there is a resume candidate from prior attempt context —
    // i.e. a branch to check out and push to DIRECTLY, as opposed to a base to
    // cut a new branch FROM. Only `resumeBranch` carries that meaning.
    //
    // This used to also fall back to `taskContext.baseBranch` ("legacy CI
    // retry field") when `resumeBranch` was absent. That fallback was
    // ambiguous by construction: `baseBranch` is ALSO the field a
    // mission-branch task's declared base arrives in (context.baseBranch =
    // the mission integration branch), and such a task never sets
    // `resumeBranch` — cutting a fresh branch from that base is exactly what
    // it wants. The two meanings are indistinguishable from `baseBranch`
    // alone, so treating it as a resume candidate made a mission-branch task
    // check out its own base directly (confirmed live, twice — task a0f00ee9
    // and its own follow-up). Every genuine resume caller now sets
    // `resumeBranch` explicitly alongside `baseBranch` (see ci-retry.ts,
    // conflict-retry.ts, workers/[id]/route.ts's request-changes retry,
    // respond/route.ts, stale-workers.ts) — this fallback is no longer needed
    // for them and is actively wrong for mission-branch tasks.
    const resumeCandidate =
      typeof taskContext?.resumeBranch === 'string' && taskContext.resumeBranch.length > 0
        ? taskContext.resumeBranch as string
        : undefined;

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
    // We only guard THIS check when branch (the parameter) itself equals the base
    // (integration branch) — see the separate `looksLikeMissionIntegrationBranch`
    // check below for the resume/requestedBranch shape of the same bug.
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
    //
    // A SECOND, independent mission-integration case (friction task f43ebcff):
    // `requestedBranch` can equal the mission branch even when `branch` never
    // does — e.g. a review-retry's `resumeBranch`/`baseBranch` both carry a
    // stale `workerBranch` that turns out to literally be the mission branch.
    // In that shape `base` resolves to `origin/<mission branch>` via the
    // ordinary (legitimate-looking) resume ladder, so an equality check against
    // `base` cannot tell it apart from a real per-task branch resume — the two
    // are structurally identical once resumeCandidate === base. The one signal
    // that IS true for a shared mission branch and false for every real
    // per-task branch is the name itself: mission branches are always
    // `mission/<slug>-<id8>` (generateMissionBranchName), never `buildd/...`.
    // Checked independently of `branchEqualsBase` so it also catches a stale
    // resume value regardless of what the task's own `branch` parameter is.
    /** Why a branch cannot be the checkout target of a new worktree, if it cannot. */
    const unusable = (candidate: string): 'default_branch' | 'checked_out' | 'mission_branch' | null =>
      candidate === defaultBranch
        ? 'default_branch'
        : branchOwners.has(candidate)
          ? 'checked_out'
          : (branchEqualsBase && candidate === baseWithoutPrefix) || looksLikeMissionIntegrationBranch(candidate)
            ? 'mission_branch'
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
          : reason === 'mission_branch'
            ? `— it is a mission integration branch; a task must never work directly on it. `
            : `— it is already checked out in worktree ${holder}. `) +
        `Using "${actualBranch}" instead (base stays ${base}). ` +
        `Pushes will target "${actualBranch}", so a new PR may be opened instead of updating an existing one.`,
      );
    }

    // THE PATH MUST FOLLOW THE BRANCH THAT IS ACTUALLY CHECKED OUT.
    //
    // `worktreePath` above is keyed on the REQUESTED branch. When the ladder
    // diverts to `uniqueBranch`, that mismatch is the whole worktree-collision
    // bug: a mission hands every one of its tasks the same shared head branch
    // (branch-names.ts, `sharedHeadBranch` precedence), the ladder then rejects
    // every candidate derived from it — `looksLikeMissionIntegrationBranch` is a
    // bare `startsWith('mission/')` test, so even `<branch>-w<id8>` is flagged —
    // and `actualBranch` keeps its per-worker default. N distinct branches, one
    // directory, and each new worker reclaimed the previous one's cwd. Same
    // shape for a task whose branch IS the repo default branch.
    //
    // Only the `uniqueBranch` landing recomputes. A resume landing
    // (`actualBranch === requestedBranch`) must NOT: a resume branch is shared
    // across the attempts that resume it, so keying the directory on it would
    // reintroduce the same collision from the other side. `uniqueBranch` embeds
    // the worker id, so it is unique per attempt by construction.
    if (actualBranch === uniqueBranch && uniqueBranch !== branch) {
      const divertedPath = join(worktreeBase, safeWorktreeDirName(actualBranch));
      if (divertedPath !== worktreePath) {
        // Through the same guard as the first reclaim — a recompute must not
        // grow a second, unguarded force-remove.
        worktreePath = reclaimOrDivert(divertedPath);
      }
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
    //
    // A repo that DECLARES an install command in `.buildd/env.yaml` owns its own
    // install via the provision gate, which enforces and blocks. One owner each:
    // declared repos → the gate; undeclared repos → this tolerant install, which
    // degrades. Running both would install twice for every declared repo.
    const declared = resolveManifest(worktreePath, {
      exists: (rel) => existsSync(join(worktreePath, rel)),
      read: (rel) => String(readFileSync(join(worktreePath, rel), 'utf-8')),
    });
    const install: InstallOutcome =
      declared.source === 'manifest' && declared.manifest?.install?.command
        ? { status: 'skipped', reason: 'declared-manifest' }
        : await installWorkspaceDeps(worktreePath, workerId);

    console.log(`[Worker ${workerId}] Worktree ready at ${worktreePath}`);
    return {
      path: worktreePath,
      branch: actualBranch,
      base,
      install,
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

/** Why a worktree removal was refused, when it was. */
export type WorktreeRemovalOutcome =
  | { removed: true }
  | { removed: false; reason: 'owned_by_live_worker' | 'unpushed_commits' };

export interface RemoveWorktreeOptions {
  repoPath: string;
  worktreePath: string;
  workerId: string;
  /** Live-worker view — the runner passes `this.workers` straight in. */
  workers: Iterable<[string, WorktreeOwnershipRecord]>;
  /** Branch checked out at `worktreePath`; required for `protectUnpushed`. */
  branch?: string;
  /** Default false. When true, also refuse a tree holding commits not on origin. */
  protectUnpushed?: boolean;
}

/**
 * Does `branch` hold commits that are not on `origin/<branch>`?
 *
 * Fail-CLOSED: an inconclusive probe (no remote branch, git error, timeout)
 * counts as unpushed. Mirrors doctor.ts's `isBranchPushed`, inverted — the cost
 * of being wrong here is a leaked directory the reaper collects, versus commits
 * that exist nowhere else.
 */
function hasUnpushedCommits(repoPath: string, branch: string | undefined): boolean {
  if (!branch) return true;
  const opts = { cwd: repoPath, timeout: 5000, encoding: 'utf-8' as const };
  try {
    const count = String(
      execSync(`git rev-list --count "origin/${branch}..${branch}"`, opts) ?? '',
    ).trim();
    const n = parseInt(count, 10);
    return isNaN(n) ? true : n > 0;
  } catch {
    return true;
  }
}

/** Shared gate for both the async and sync removal entry points. */
function removalRefusal(opts: RemoveWorktreeOptions): WorktreeRemovalOutcome | null {
  const { repoPath, worktreePath, workerId, workers } = opts;
  if (isWorktreePathOwnedByOtherLiveWorker(workers, worktreePath, workerId)) {
    const msg = `Refused to remove worktree ${worktreePath}: owned by another live worker`;
    sessionLog(workerId, 'warn', 'worktree_removal_skipped_owned', msg);
    console.warn(`[Worker ${workerId}] ${msg} (force-remove exits 0 after destroying its work)`);
    return { removed: false, reason: 'owned_by_live_worker' };
  }
  if (opts.protectUnpushed && hasUnpushedCommits(repoPath, opts.branch)) {
    const msg = `Refused to remove worktree ${worktreePath}: commits are not on origin`;
    sessionLog(workerId, 'warn', 'worktree_removal_skipped_unpushed', msg);
    console.warn(`[Worker ${workerId}] ${msg}`);
    return { removed: false, reason: 'unpushed_commits' };
  }
  return null;
}

/**
 * THE removal entry point for runner-side worktree teardown.
 *
 * Refuses to touch a path a live worker owns. `cleanupWorktree` above is the
 * executor and must not be called directly from a teardown path — the ownership
 * predicate already existed (privately, in worker-sync.ts) and still covered
 * only two of six removal sites, which is precisely the failure mode one
 * exported executor removes. The reaper in doctor.ts is the one legitimate
 * direct caller: it has its own record-based gates and no in-memory map.
 */
export async function removeWorktreeIfUnowned(
  opts: RemoveWorktreeOptions,
): Promise<WorktreeRemovalOutcome> {
  const refusal = removalRefusal(opts);
  if (refusal) return refusal;
  await cleanupWorktree(opts.repoPath, opts.worktreePath, opts.workerId);
  return { removed: true };
}

/**
 * Synchronous sibling for `destroy()`, which runs on process teardown with no
 * event loop left to await on. Shares `removalRefusal` — the predicate is the
 * part that must never be duplicated.
 */
export function removeWorktreeIfUnownedSync(
  opts: RemoveWorktreeOptions,
): WorktreeRemovalOutcome {
  const refusal = removalRefusal(opts);
  if (refusal) return refusal;
  const { repoPath, worktreePath, workerId } = opts;
  try {
    console.log(`[Worker ${workerId}] Removing worktree: ${worktreePath}`);
    execSync(`git worktree remove --force "${worktreePath}"`, { cwd: repoPath, timeout: 5000 });
  } catch {
    try { rmSync(worktreePath, { recursive: true, force: true }); } catch {}
  }
  return { removed: true };
}

/**
 * Collect git stats (commits, files changed, lines added/removed) from a working directory.
 * @param cwd - The working directory to collect stats from
 * @param workerId - For logging
 * @param fallbackCommitCount - Fallback count if git rev-list fails (e.g. from worker.commits.length)
 * @param baseRef - The ref this worktree was actually cut from (setupWorktree's
 *   `SetupWorktreeResult.base`, e.g. `origin/main` or a mission integration
 *   branch). When present, this is what commit-count and diff stats are
 *   measured against — a branch cut from a mission integration branch must
 *   report its OWN diff, not the integration branch's whole diff vs
 *   dev/main/master. Falls back to that dev/main/master search when absent
 *   (older callers, or a worktree set up before this field existed).
 */
export async function collectGitStats(
  cwd: string | undefined,
  workerId: string,
  fallbackCommitCount?: number,
  baseRef?: string,
): Promise<GitStats> {
  if (!cwd) return {};

  const opts = { cwd, timeout: 5000, encoding: 'utf-8' as const };
  const stats: Record<string, number | string | boolean | undefined> = {};

  // Resolve the ref this worktree's own commits are measured against.
  // Prefer the ref this worktree was actually cut from; a branch cut from a
  // mission integration branch must compare against THAT branch, not
  // dev/main/master — comparing against dev there reports the integration
  // branch's whole accumulated history as this worker's own, even when this
  // worker made zero commits of its own. Shared by the lastCommitSha trust
  // check below and the diff, which must agree on the same base.
  let mergeBase = '';
  if (baseRef) {
    try {
      const result = execSync(`git merge-base HEAD ${baseRef} 2>/dev/null`, opts).trim();
      if (result) mergeBase = result;
    } catch {}
  }
  if (!mergeBase) {
    for (const candidate of ['origin/dev', 'origin/main', 'origin/master']) {
      try {
        const result = execSync(`git merge-base HEAD ${candidate} 2>/dev/null`, opts).trim();
        if (result) { mergeBase = result; break; }
      } catch {}
    }
  }

  try {
    const head = execSync('git rev-parse HEAD', opts).trim();
    // A SHA equal to the resolved merge-base is the BASE's own tip, not a
    // commit this worker made — the base moves as sibling branches/missions
    // merge into it, so a worktree that never diverged from its base (zero
    // real commits) would otherwise report the base's latest merge as if it
    // were "this worker's last commit". Only report it once HEAD is
    // confirmed ahead of the base; with no base to compare against at all,
    // report what we have rather than withhold it silently.
    if (head && (!mergeBase || head !== mergeBase)) {
      stats.lastCommitSha = head;
    }
  } catch {}
  try {
    // Count commits on this branch vs the ref it was actually cut from. Kept
    // independent of `mergeBase` above (which anchors the diff and the SHA
    // trust check to a fixed candidate order): this resolves the base via
    // the worktree's own upstream when baseRef is absent, which for a plain
    // trunk-cut branch is the more precise comparison ref.
    let compareRef = baseRef;
    if (!compareRef) {
      const defaultBranch = execSync('git rev-parse --abbrev-ref HEAD@{upstream}', opts).trim().replace(/^origin\//, '') || 'main';
      compareRef = `origin/${defaultBranch}`;
    }
    const count = execSync(`git rev-list --count HEAD ^${compareRef}`, opts).trim();
    stats.commitCount = parseInt(count, 10) || 0;
  } catch {
    // Fallback: use locally tracked commits
    if (fallbackCommitCount !== undefined) stats.commitCount = fallbackCommitCount;
  }
  try {
    // Compute full PR diff against the resolved merge-base so we capture all
    // commits on this branch, not just the last commit. A diff with no
    // resolvable base is not reported: the previous `HEAD~1` fallback showed
    // the parent of whatever HEAD happens to be — on a worktree with zero
    // commits of its own that parent is an unrelated ancestor (possibly
    // another task's already-merged work), not this worker's diff.
    if (mergeBase) {
      const numstat = execSync(`git diff --numstat ${mergeBase} 2>/dev/null || true`, opts).trim();
      let added = 0, removed = 0, files = 0;
      if (numstat) {
        for (const line of numstat.split('\n')) {
          const [a, r, ...fileParts] = line.split('\t');
          // Skip files generated by tooling (e.g. Drizzle snapshot JSON) — this
          // self-reported diff is what task/PR cards render before a PR exists,
          // and a migration snapshot must not read as the diff size there either.
          // See packages/shared/src/generated-paths.ts.
          if (a !== '-' && !isGeneratedPath(fileParts.join('\t'))) {
            added += parseInt(a, 10) || 0; removed += parseInt(r, 10) || 0; files++;
          }
        }
      }
      stats.filesChanged = files;
      stats.linesAdded = added;
      stats.linesRemoved = removed;
    }
  } catch {}
  try {
    // Tracked-file modifications only — an untracked (`??`) entry is not
    // something to commit-and-PR-or-discard, it's just a scratch file the
    // agent hasn't decided about yet.
    const porcelain = execSync('git status --porcelain', opts).toString();
    stats.dirtyWorktree = porcelain
      .split('\n')
      .some(line => line.length > 0 && !line.startsWith('??'));
  } catch {}

  return stats;
}
