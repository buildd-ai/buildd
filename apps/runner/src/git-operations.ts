/**
 * Git operations for worker sessions — worktree setup/cleanup and stats collection.
 * Extracted from WorkerManager to reduce workers.ts complexity.
 */

import * as cp from 'child_process';
import * as fs from 'fs';
import { join, resolve } from 'path';
import {
  resolveWorktreeBase,
  clearResumeContext,
  parseWorktreeList,
  isWorktreePathOwnedByOtherLiveWorker,
  classifyResumeBranchHolder,
  resolveReleaseHeldBranchMode,
  RELEASE_LINEAGE_HELD_BRANCH_FLAG,
  type BranchFetchResult,
  type LineageHolderRecord,
  type ResumeLineage,
  type WorktreeOwnershipRecord,
} from './worktree-utils';
import { sessionLog as realSessionLog } from './session-logger';
import { archiveWorktreeWork, archiveWorktreeWorkSync, type ArchiveResult } from './worktree-archive';
import { isGeneratedPath } from '@buildd/shared';
import { detectInstallPlans, resolveManifest, MANIFEST_PATH } from './env-verify';
import { looksLikeMissionIntegrationBranch } from '@buildd/core/mission-integration';
import { describePrimaryCloneDrift } from './worktree-confinement';
import { diagnoseRegistryAuth, type RegistryAuthDiagnosis } from './install-diagnosis';
import { emitPhase, emitWorktreeMode } from './phase-lines';
import { branchOfRemoteRef, ensureRemoteBranch, isCloudExecutor, type GitCwdRun, type RemoteBranchResult } from './git-clone';

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
// Archive-before-remove. Real by default; __setGitOpsDeps swaps in no-ops unless
// the test supplies its own (it is mocking fs/git already, so a real archive
// would probe paths that only exist in the mock).
let archiveAsync: typeof archiveWorktreeWork = archiveWorktreeWork;
let archiveSync: typeof archiveWorktreeWorkSync = archiveWorktreeWorkSync;
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
  /** Optional: replace the archive step (default in tests: no-op). */
  archive?: typeof archiveWorktreeWork;
  archiveSync?: typeof archiveWorktreeWorkSync;
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
  archiveAsync = mocks.archive ?? (async () => ({ archived: false }));
  archiveSync = mocks.archiveSync ?? (() => ({ archived: false }));
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
  archiveAsync = archiveWorktreeWork;
  archiveSync = archiveWorktreeWorkSync;
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

/**
 * Why an install failed, in the terms a caller can act on. The split that
 * matters is structural-host-fault (`registry-auth`, `toolchain-missing` — the
 * agent cannot fix these and they hit every task on the host) versus everything
 * else. "Nothing to install" is not in here: that is a `skipped` outcome, not a
 * failure, and treating it as one is what produced the old false alarms.
 */
export type InstallFailureClass =
  | 'registry-auth'
  | 'toolchain-missing'
  | 'lockfile-drift'
  | 'timeout'
  | 'unknown';

/** The outcome of the runner's own dependency install for a worktree. */
export type InstallOutcome =
  | { status: 'ok'; dirs: string[]; unfrozen?: boolean }
  | { status: 'skipped'; reason: 'no-manifest' | 'non-bun-toolchain' | 'declared-manifest' | 'deferred' }
  | { status: 'failed'; dir: string; failure: InstallFailureClass; message: string; registry?: RegistryAuthDiagnosis };

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
  // Before the auth check: yarn 2+'s drift message says "explicitly forbidden".
  if (/lockfile would have been modified/.test(text)) return 'lockfile-drift';
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
  // pnpm: ERR_PNPM_OUTDATED_LOCKFILE / "pnpm-lock.yaml is not up to date with
  // package.json"; npm ci: "can only install packages when your package.json
  // and package-lock.json ... are in sync"; yarn 2+: "The lockfile would have
  // been modified by this install".
  if (/lockfile had changes|lockfile is frozen|lockfile is outdated|outdated_lockfile|lockfile needs to be updated|lockfile would (be|have been) (modified|updated)|is not up to date with|can only install packages when your package\.json/.test(text)) {
    return 'lockfile-drift';
  }
  return 'unknown';
}

/**
 * How one toolchain installs: the frozen/ci form first, the unfrozen form only
 * when the frozen one rejected the lockfile (classifyInstallFailure). Scripts
 * stay on: measured on a pnpm repo, `--ignore-scripts` saved nothing and broke
 * `--offline` on a git dependency. Null for a toolchain the runner does not
 * install (python, cargo, go: a declared `.buildd/env.yaml` covers those).
 */
export interface InstallCommand {
  bin: string;
  frozen: string[];
  unfrozen: string[];
}

export function installCommandFor(runtime: string, opts: { yarnBerry?: boolean } = {}): InstallCommand | null {
  switch (runtime) {
    case 'bun': return { bin: 'bun', frozen: ['install', '--frozen-lockfile'], unfrozen: ['install'] };
    case 'pnpm': return { bin: 'pnpm', frozen: ['install', '--frozen-lockfile'], unfrozen: ['install', '--no-frozen-lockfile'] };
    // Yarn 2+ (a `.yarnrc.yml` next to the lockfile) renamed the flag.
    case 'yarn': return opts.yarnBerry
      ? { bin: 'yarn', frozen: ['install', '--immutable'], unfrozen: ['install'] }
      : { bin: 'yarn', frozen: ['install', '--frozen-lockfile'], unfrozen: ['install'] };
    // package-lock.json: LOCKFILE_RULES calls its runtime `node`.
    case 'node': return { bin: 'npm', frozen: ['ci'], unfrozen: ['install'] };
    default: return null;
  }
}

/** Host runners: one bun install, bounded so a stuck registry cannot hold worktree setup. */
const HOST_INSTALL_TIMEOUT_MS = 120_000;
/**
 * Cloud: the install runs behind the agent session (deps-gate.ts), so it can
 * take as long as a cold pnpm install on a slow disk does (92-103 s typical
 * on standard-3, after a 30-180 s cache restore) without blocking anything.
 */
export const CLOUD_INSTALL_TIMEOUT_MS = 600_000;

export interface InstallOptions {
  /**
   * Install every Node lockfile toolchain (pnpm, npm, yarn, bun), not only
   * bun. Cloud executor only: a cloud container runs one task in a clone
   * nobody else uses, and without it a pnpm repo got no install and the agent
   * improvised one.
   */
  allToolchains?: boolean;
  timeoutMs?: number;
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
 * On a host runner it stays BUN-ONLY for the auto-detected path: it exists to
 * create bun's nested workspace symlinks, and a shared host clone running `npm
 * ci` for every worktree is a different risk profile. A non-bun lockfile there
 * yields `{status:'skipped', reason:'non-bun-toolchain'}` — honest, and
 * recorded. In a cloud container (`allToolchains`) every Node lockfile
 * toolchain installs (installCommandFor). Repos that need anything else
 * declare `.buildd/env.yaml` and the provision gate owns it.
 *
 * `installEnv` is the worker's resolved secret env (role env today), overlaid
 * on the runner's own env. Without it a repo whose `.npmrc` reads
 * `${NODE_AUTH_TOKEN}` could only ever get that token from the host
 * container, because this runs before the agent env exists. Values are never
 * logged — only the key count.
 */
export async function installWorkspaceDeps(
  worktreePath: string,
  workerId: string,
  installEnv?: Record<string, string>,
  opts: InstallOptions = {},
): Promise<InstallOutcome> {
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

  const runnable = plans.flatMap((plan) => {
    if (!opts.allToolchains && plan.runtime !== 'bun') return [];
    const dir = plan.dir === '.' ? worktreePath : join(worktreePath, plan.dir);
    const command = installCommandFor(plan.runtime, { yarnBerry: existsSync(join(dir, '.yarnrc.yml')) });
    return command ? [{ plan, command }] : [];
  });
  if (runnable.length === 0) {
    console.log(
      `[Worker ${workerId}] Worktree uses a non-bun toolchain (${plans.map(p => p.runtime).join(', ')}) ` +
      `— skipping install; declare ${MANIFEST_PATH} to have the provision gate run it`,
    );
    return { status: 'skipped', reason: 'non-bun-toolchain' };
  }

  // Phase markers for the cloud runner's run report (phase-lines.ts; printed
  // only in a cloud container). Only the runner's own install is timed: a
  // declared manifest's install runs in the provision gate instead.
  emitPhase('install_start');
  try {
    return await runInstalls(worktreePath, workerId, runnable, installEnv, opts.timeoutMs ?? HOST_INSTALL_TIMEOUT_MS);
  } finally {
    emitPhase('install_end');
  }
}

async function runInstalls(
  worktreePath: string,
  workerId: string,
  runnable: Array<{ plan: ReturnType<typeof detectInstallPlans>[number]; command: InstallCommand }>,
  installEnv: Record<string, string> | undefined,
  timeoutMs: number,
): Promise<InstallOutcome> {
  const dirs: string[] = [];
  let usedUnfrozen = false;

  // No overlay → no `env` key at all, so execFile inherits exactly as before.
  const hasOverlay = !!installEnv && Object.keys(installEnv).length > 0;
  const env = hasOverlay ? { ...process.env, ...installEnv } : undefined;
  if (hasOverlay) {
    console.log(`[Worker ${workerId}] Install env carries ${Object.keys(installEnv!).length} worker-resolved var(s)`);
  }
  const failed = (dir: string, failure: InstallFailureClass, message: string): InstallOutcome => {
    if (failure !== 'registry-auth') return { status: 'failed', dir, failure, message };
    const registry = diagnoseRegistryAuth(
      message,
      dir,
      (rel) => {
        const abs = join(worktreePath, rel);
        return existsSync(abs) ? String(readFileSync(abs, 'utf-8')) : null;
      },
      env ?? process.env,
    );
    return { status: 'failed', dir, failure, message, registry };
  };

  for (const { plan, command } of runnable) {
    const cwd = plan.dir === '.' ? worktreePath : join(worktreePath, plan.dir);
    const opts = { cwd, timeout: timeoutMs, encoding: 'utf-8' as const, ...(env ? { env } : {}) };
    // new Promise + execFile directly rather than util.promisify, so mock
    // injection via __setGitOpsDeps works consistently across bun versions.
    const run = (args: string[]) => new Promise<void>((resolve, reject) => {
      execFile(command.bin, args, opts, (err) => { if (err) reject(err); else resolve(); });
    });
    const label = `${command.bin} ${command.frozen.join(' ')}`;

    console.log(`[Worker ${workerId}] Running ${label} in ${plan.dir}...`);
    try {
      await run(command.frozen);
      dirs.push(plan.dir);
      continue;
    } catch (err) {
      const failure = classifyInstallFailure(err);
      if (failure !== 'lockfile-drift') {
        console.warn(
          `[Worker ${workerId}] ${command.bin} install in ${plan.dir} failed (${failure}): ${errMessage(err)}`,
        );
        return failed(plan.dir, failure, errMessage(err));
      }
      console.warn(
        `[Worker ${workerId}] ${label} in ${plan.dir} rejected the lockfile, retrying unfrozen: ${errMessage(err)}`,
      );
    }

    try {
      await run(command.unfrozen);
      dirs.push(plan.dir);
      usedUnfrozen = true;
    } catch (err) {
      const failure = classifyInstallFailure(err);
      console.warn(
        `[Worker ${workerId}] Unfrozen ${command.bin} install in ${plan.dir} failed (${failure}): ${errMessage(err)}`,
      );
      return failed(plan.dir, failure, errMessage(err));
    }
  }

  console.log(`[Worker ${workerId}] Dependencies installed in: ${dirs.join(', ')}`);
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
   * Returned so callers read the real base. A caller that
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
  /**
   * Set only with `deferInstall` (and no declared manifest): the install,
   * not yet started. `install` then reads `skipped: deferred`; the caller owns
   * running this and surfacing its outcome.
   */
  deferredInstall?: () => Promise<InstallOutcome>;
  /** Set when resume candidate was requested but not usable (missing/diverged),
   *  causing a fresh start from the default branch.  Callers should surface
   *  this as a visible warning rather than silently degrading. */
  fallback?: { candidate: string; reason: 'missing' | 'diverged' };
  /** Set when a resume/base candidate resolved to a branch that cannot be the
   *  worktree's own checkout — the repo default branch, or a branch another
   *  worktree already holds. The task's own `branch` was used instead, so the
   *  worker keeps its isolated worktree instead of failing setup and
   *  degrading into the shared repo root. `holder` is the worktree that owns the
   *  branch, when known. */
  sharedBranch?: {
    candidate: string;
    reason: 'default_branch' | 'checked_out' | 'mission_branch';
    holder?: string;
  };
  /**
   * Set when `base` is more than 10 commits behind `origin/<defaultBranch>` at
   * setup time. Previously `console.warn`-only (a line nobody but someone
   * tailing runner logs would ever see) — returned now so the caller can
   * surface it the same way it already surfaces `fallback`: an appended error
   * trace on the worker, visible on the dashboard and to `get_error_traces`.
   */
  staleBase?: { ref: string; defaultBranch: string; commitsBehind: number };
}

/**
 * Probe the primary clone and log a loud warning when it is dirty, holds
 * stashes, or is off `expectedBranch`. Warning only — never resets: a dirty
 * primary may hold the only copy of someone's work. Every probe failure is
 * swallowed; this must never block worktree setup.
 */
export function warnOnPrimaryCloneDrift(repoPath: string, expectedBranch: string, workerId: string): string | null {
  const opts = { cwd: repoPath, timeout: 10000, encoding: 'utf-8' as const, stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'] };
  const run = (cmd: string): string | undefined => {
    try {
      const out = execSync(cmd, opts);
      return typeof out === 'string' ? out : undefined;
    } catch {
      return undefined;
    }
  };
  const lines = (s: string | undefined) => (s ?? '').split('\n').filter(l => l.trim().length > 0).length;
  const branch = run('git rev-parse --abbrev-ref HEAD')?.trim() || undefined;
  const warning = describePrimaryCloneDrift({
    branch,
    expectedBranch,
    dirtyEntries: lines(run('git status --porcelain')),
    stashes: lines(run('git stash list')),
  });
  // Runs on every worker start: print a given drift once per repo per process,
  // again only when it changes (or clears and comes back). The per-worker
  // session log still records it every time.
  const previous = lastPrimaryCloneDrift.get(repoPath);
  if (warning) {
    if (warning !== previous) {
      console.warn(`[Worker ${workerId}] ${warning} (${repoPath})`);
      lastPrimaryCloneDrift.set(repoPath, warning);
    }
    try { sessionLog(workerId, 'warn', 'primary_clone_drift', warning); } catch { /* best effort */ }
  } else if (previous !== undefined) {
    console.log(`[Worker ${workerId}] Primary clone drift cleared (${repoPath})`);
    lastPrimaryCloneDrift.delete(repoPath);
  }
  return warning;
}

/** Last drift warning printed per primary clone path (this process only). */
const lastPrimaryCloneDrift = new Map<string, string>();

/** Test hook: forget which drift warnings were already printed. */
export function __resetPrimaryCloneDriftWarnings(): void {
  lastPrimaryCloneDrift.clear();
}

/** Branch name → directory name. The only place this mapping is spelled. */
/** git through this module's (injectable) execSync, for the git-clone.ts helpers. */
function gitPort(cwd: string): GitCwdRun {
  const q = (a: string) => `'${a.replace(/'/g, `'\\''`)}'`;
  return (args, timeoutMs) => {
    try {
      const out = execSync(`git ${args.map(q).join(' ')}`, { cwd, timeout: timeoutMs, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
      return { status: 0, stdout: String(out ?? ''), stderr: '', signal: null };
    } catch (err) {
      const e = err as { status?: unknown; stdout?: unknown; stderr?: unknown; message?: unknown; signal?: unknown };
      return {
        status: typeof e?.status === 'number' ? e.status : 1,
        stdout: String(e?.stdout ?? ''),
        stderr: String(e?.stderr ?? e?.message ?? ''),
        signal: (typeof e?.signal === 'string' ? e.signal : null) as NodeJS.Signals | null,
      };
    }
  };
}

/**
 * `origin/<branch>` on demand: in a narrow (cloud) clone, which holds the
 * default branch only, fetch it by name (git-clone.ts ensureRemoteBranch). A
 * full clone: a no-op, its `git fetch origin` already brought every branch.
 */
function ensureOriginBranch(repoPath: string, branch: string, workerId: string): RemoteBranchResult {
  return ensureRemoteBranch(repoPath, branch, { run: gitPort(repoPath), log: (m) => console.log(`[Worker ${workerId}] ${m}`) });
}

function isShallowClone(repoPath: string): boolean {
  try {
    return String(execSync('git rev-parse --is-shallow-repository', { cwd: repoPath, timeout: 5000, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }) ?? '').trim() === 'true';
  } catch {
    return false;
  }
}

/** Why setupWorktree last returned null, per worker: git's own text, for the start failure. */
const setupWorktreeErrors = new Map<string, string>();

/**
 * Why setupWorktree last returned null for `workerId` (trimmed), once. The
 * caller fails the worker with it, so the task says what git refused instead
 * of only that it did.
 */
export function takeSetupWorktreeError(workerId: string): string | undefined {
  const why = setupWorktreeErrors.get(workerId);
  setupWorktreeErrors.delete(workerId);
  return why;
}

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
  /**
   * Worker-resolved env overlaid onto the tolerant install (undeclared repos
   * only — a declared repo's install runs in the provision gate with the full
   * agent env). See installWorkspaceDeps.
   */
  installEnv?: Record<string, string>,
  /**
   * The retry's task identity (M1, knowledge-base: buildd/design/pr-merge-reliability.md). With
   * it, a resume branch still checked out in a TERMINAL prior attempt's
   * retained worktree of the same lineage can be released instead of diverting
   * to a fresh branch (+ new PR). On by default; BUILDD_RELEASE_LINEAGE_HELD_BRANCH=0
   * is the kill switch to shadow (log only). `onHolderReleased` must make the holder worker
   * non-resumable — its tree is detached under it.
   */
  resumeLineage?: ResumeLineage & { onHolderReleased?: (holderWorkerId: string) => void },
  /**
   * `deferInstall` (cloud executor only): do not run the tolerant install
   * here. The result carries `deferredInstall` instead, and the caller runs it
   * behind the agent session (deps-gate.ts). A declared manifest is untouched:
   * the provision gate still owns that install.
   */
  setupOpts: { deferInstall?: boolean } = {},
): Promise<SetupWorktreeResult | null> {
  const cloud = isCloudExecutor(process.env);
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
  let worktreePath = cloud ? repoPath : join(worktreeBase, safeBranch);

  try {
    // Ensure worktree base directory exists
    if (!cloud) mkdirSync(worktreeBase, { recursive: true });

    // Add .buildd-worktrees to .git/info/exclude if not already there
    const excludePath = join(repoPath, '.git', 'info', 'exclude');
    if (!cloud && existsSync(excludePath)) {
      const excludeContent = readFileSync(excludePath, 'utf-8');
      if (!excludeContent.includes('.buildd-worktrees')) {
        appendFileSync(excludePath, '\n.buildd-worktrees\n');
      }
    }

    // Cloud acquisition already fetched the default; candidate refs are fetched by name.
    if (!cloud) console.log(`[Worker ${workerId}] Fetching latest from remote...`);
    try {
      if (!cloud) execSync('git fetch origin', execOpts);
    } catch (err) {
      console.warn(`[Worker ${workerId}] git fetch failed (continuing with local state):`, err instanceof Error ? err.message : err);
    }

    // The primary clone should be a pristine base that nobody works in. If it
    // is dirty or off its branch, something has been working in the shared
    // checkout — say so loudly. Never reset it: it may hold unpushed work.
    if (!cloud) warnOnPrimaryCloneDrift(repoPath, defaultBranch, workerId);

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

    if (!cloud) worktreePath = reclaimOrDivert(worktreePath);

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
    const explicitResumeCandidate =
      typeof taskContext?.resumeBranch === 'string' && taskContext.resumeBranch.length > 0
        ? taskContext.resumeBranch as string
        : undefined;

    // Warn if parent repo has sparse checkout enabled. Git worktrees get their
    // own sparse-checkout config so this doesn't directly affect the worktree,
    // but it's worth logging so the pattern is visible if issues recur.
    //
    // stdio is fully piped (not the execSync default, which inherits fd 2):
    // on a non-sparse repo this throws on every single call, and with the
    // default stdio its stderr text streams straight into the runner's real
    // log on every worker start. Piping keeps the throw (still caught below)
    // without the leak.
    try {
      const sparsePatterns = execSync('git sparse-checkout list', { ...execOpts, timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
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
    // fetchBranch uses already-fetched remote tracking refs (git fetch origin
    // ran above). A narrow (cloud) clone holds the default branch only, so the
    // candidate is fetched by name first (ensureOriginBranch); a full clone
    // skips that.
    const fetchBranch = async (candidate: string): Promise<BranchFetchResult> => {
      if (ensureOriginBranch(repoPath, candidate, workerId) === 'missing') return 'missing';
      try {
        const countStr = String(execSync(
          `git rev-list --count "origin/${defaultBranch}..origin/${candidate}"`,
          // Piped: a missing candidate is an expected negative (caught below and
          // logged by resolveWorktreeBase). Inherited stderr put git's
          // "fatal: ambiguous argument" in the runner log on every such start.
          { ...execOpts, timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] },
        ) ?? '').trim();
        const count = parseInt(countStr, 10);
        if (!isNaN(count) && count > 50) {
          // In a shallow clone the count is only a count of commits ahead when
          // the merge base is here. Without it, the walk runs to the shallow
          // boundary and counts every fetched commit: a branch cut a week ago
          // and a few commits ahead would read as diverged and lose its PR.
          // Undecidable here, so not a veto.
          if (isShallowClone(repoPath)) {
            try {
              execSync(`git merge-base "origin/${defaultBranch}" "origin/${candidate}"`, { ...execOpts, timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] });
            } catch {
              console.log(
                `[Worker ${workerId}] origin/${candidate} has no merge base with origin/${defaultBranch} in this shallow clone; ` +
                `divergence cannot be measured, treating it as usable`,
              );
              return 'ok';
            }
          }
          return 'diverged';
        }
        return 'ok';
      } catch {
        // Command fails when origin/<candidate> ref doesn't exist
        return 'missing';
      }
    };
    // Does `refs/heads/<candidate>` exist in THIS clone (as opposed to
    // `origin/<candidate>`, which `fetchBranch` above already checks)?
    const localBranchExists = (candidate: string): boolean => {
      try {
        execSync(`git rev-parse --verify --quiet "refs/heads/${candidate}"`, {
          ...execOpts, timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'],
        });
        return true;
      } catch {
        return false;
      }
    };

    // How many commits does local ref `candidate` carry that origin/<default>
    // does not? Zero (not an error) when the range can't be computed at all —
    // e.g. origin/<default> itself isn't a valid remote-tracking ref yet.
    const countCommitsAheadOfDefault = (candidate: string): number => {
      try {
        const out = execSync(
          `git rev-list --count "origin/${defaultBranch}..${candidate}"`,
          { ...execOpts, timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] },
        ).trim();
        const n = parseInt(out, 10);
        return isNaN(n) ? 0 : n;
      } catch {
        return 0;
      }
    };

    // A task branch already on origin with commits beyond the default branch is
    // an earlier attempt's work (a usage-limit checkpoint, a pushed WIP), even
    // when the brief carries no `resumeBranch`. Cutting fresh from the default
    // branch would make the first push non-fast-forward, so treat it as the
    // resume candidate. Mission integration branches are never resumed this way.
    const resumeCandidate =
      explicitResumeCandidate ??
      (branch !== defaultBranch &&
      !looksLikeMissionIntegrationBranch(branch) &&
      (await fetchBranch(branch)) === 'ok' &&
      countCommitsAheadOfDefault(`origin/${branch}`) > 0
        ? branch
        : undefined);
    if (resumeCandidate && !explicitResumeCandidate) {
      console.log(
        `[Worker ${workerId}] origin/${branch} already carries work for this task and no resumeBranch was given — resuming from it.`,
      );
    }

    let fallback: SetupWorktreeResult['fallback'];
    let base: string;
    // A prior attempt on this task branch committed but was killed before
    // pushing (task branches are stable across retries — the requested branch
    // IS the prior attempt's branch). `origin/<resumeCandidate>` being absent
    // then does not mean the work is gone: `refs/heads/<resumeCandidate>` in
    // THIS clone is still the only ref holding those commits. Resolving the
    // ladder via resolveWorktreeBase()/fetchBranch (origin-only) would read
    // that as 'missing', clear the resume context, and fall back to a fresh
    // branch off the default — at which point the "delete stale local
    // branches" loop below deletes the only ref holding the unpushed commits.
    // Checked BEFORE resolveWorktreeBase so the normal fallback machinery
    // (and its clearResumeContext side effect) never runs for this branch.
    const resumeFromLocalBranch =
      !!resumeCandidate &&
      (await fetchBranch(resumeCandidate)) === 'missing' &&
      localBranchExists(resumeCandidate) &&
      countCommitsAheadOfDefault(resumeCandidate) > 0;

    if (resumeFromLocalBranch) {
      base = resumeCandidate as string;
      console.log(
        `[Worker ${workerId}] resumeBranch "${resumeCandidate}" is missing on origin but exists locally ` +
        `with unpushed commits — resuming from the local branch instead of starting fresh.`,
      );
    } else {
      base = await resolveWorktreeBase({
        defaultBranch,
        context: explicitResumeCandidate ? taskContext : resumeCandidate ? { ...taskContext, resumeBranch: resumeCandidate } : taskContext,
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
    }

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
    let staleBase: SetupWorktreeResult['staleBase'];
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
        staleBase = { ref: base, defaultBranch, commitsBehind };
      }
    } catch {
      // Non-fatal: git rev-list can fail for repos with no remote or when the
      // base ref is not yet a local remote-tracking ref.
    }

    // When the resume candidate was usable (no fallback), check out THAT branch
    // directly so the worker pushes to the existing PR's branch rather than
    // opening a new branch/PR.  On fallback, use the task's own branch (fresh).
    const requestedBranch =
      resumeCandidate && !fallback && (resumeFromLocalBranch || base === `origin/${resumeCandidate}`)
        ? resumeCandidate
        : branch;

    // Which branches are already checked out somewhere in this repo? Computed
    // AFTER the stale-worktree cleanup above so a path we just reclaimed isn't
    // counted as a holder.
    const branchOwners = listBranchOwners(execOpts);
    // The single-task cloud clone is our session, not another branch holder.
    if (cloud) for (const [name, path] of branchOwners) {
      if (resolve(path) === resolve(repoPath)) branchOwners.delete(name);
    }

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

    // A resume that lands directly on `resumeCandidate` (no branch is cut FROM
    // base — base IS the branch being checked out, see `checkoutExistingBranch`
    // below) is not the mission-integration bug this guard exists for: there is
    // no "should have been cut from base" step to have skipped. Excluded so a
    // task whose branch is stable across retries (branch === resumeCandidate,
    // the normal shape once a task keeps the same branch on every attempt) can
    // resume onto its own branch instead of being diverted to a fresh
    // per-worker one on every single retry.
    const isDirectResumeTarget =
      !!resumeCandidate && !fallback &&
      (resumeFromLocalBranch || base === `origin/${resumeCandidate}`);

    // Shared-branch guard.  A worktree cannot be checked out onto the repo
    // default branch (the main clone holds it) nor onto a branch another
    // worktree already holds — git fails with "a branch named 'X' already
    // exists" / "cannot delete branch 'X' used by worktree at …".  Tasks whose
    // context carried baseBranch:"dev" used to hit exactly that: every
    // concurrent worker but one failed setup and was silently degraded into the
    // shared role-clone root (no fs isolation).  Fall back to the task's
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
          : (branchEqualsBase && candidate === baseWithoutPrefix && !(isDirectResumeTarget && candidate === resumeCandidate)) ||
              looksLikeMissionIntegrationBranch(candidate)
            ? 'mission_branch'
            : null;

    // M1 — lineage-held resume branch. The branch we mean to resume is still
    // checked out in another worktree; usually the prior attempt's, retained
    // for ~10 minutes after it went terminal. Diverting here opens a second PR
    // and supersedes the first. When the holder is provably a terminal worker
    // of this task's own retry lineage (the runner's registry, never the
    // path's shape), with a clean tree and nothing unpushed, detach it and
    // take the branch. One structured `resume_branch_held` line per held
    // resume either way; with the flag off it only says what it would do.
    if (
      resumeCandidate && isDirectResumeTarget && requestedBranch === resumeCandidate &&
      branchOwners.has(resumeCandidate)
    ) {
      const holderPath = branchOwners.get(resumeCandidate) as string;
      const mode = resolveReleaseHeldBranchMode();
      const verdict = liveWorkers
        ? classifyResumeBranchHolder(
            liveWorkers as Iterable<[string, LineageHolderRecord]>, holderPath, resumeLineage, workerId,
            (p) => { try { return fs.realpathSync(p); } catch { return p; } },
          )
        : ({ eligible: false, reason: 'no_registry_owner' } as const);
      let reason: string | undefined = verdict.eligible ? undefined : verdict.reason;
      if (!reason && !worktreeIsReclaimable(holderPath, execOpts)) reason = 'holder_dirty';
      if (!reason) {
        // Commits on the local branch that its remote tip lacks — that is
        // unpushed work only this ref holds. An inconclusive count (e.g. no
        // origin/<branch>) is treated as unpushed.
        try {
          const n = parseInt(execSync(
            `git rev-list --count "origin/${resumeCandidate}..refs/heads/${resumeCandidate}"`,
            { ...execOpts, timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] },
          ).trim(), 10);
          if (isNaN(n) || n > 0) reason = 'holder_unpushed';
        } catch {
          reason = 'holder_unpushed';
        }
      }
      let decision: 'released' | 'would_release' | 'refused' = reason ? 'refused' : mode === 'release' ? 'released' : 'would_release';
      if (decision === 'released') {
        try {
          // Keeps the holder's tree (for forensics); frees only the branch ref.
          execSync('git checkout --detach', { ...execOpts, cwd: holderPath, timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] });
          branchOwners.delete(resumeCandidate);
          const holderId = verdict.eligible ? verdict.holderWorkerId : undefined;
          if (holderId) {
            try { resumeLineage?.onHolderReleased?.(holderId); } catch { /* best effort */ }
          }
        } catch {
          decision = 'refused';
          reason = 'detach_failed';
        }
      }
      const record = {
        event: 'resume_branch_held',
        flag: RELEASE_LINEAGE_HELD_BRANCH_FLAG,
        mode,
        decision,
        released: decision === 'released',
        candidate: resumeCandidate,
        holder: holderPath,
        ...(verdict.holderWorkerId ? { holderWorkerId: verdict.holderWorkerId } : {}),
        ...(reason ? { reason } : {}),
      };
      console.log(`[Worker ${workerId}] [resume-branch-held] ${JSON.stringify(record)}`);
      try { sessionLog(workerId, decision === 'released' ? 'info' : 'warn', 'resume_branch_held', JSON.stringify(record)); } catch { /* best effort */ }
    }

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
    if (!cloud && actualBranch === uniqueBranch && uniqueBranch !== branch) {
      const divertedPath = join(worktreeBase, safeWorktreeDirName(actualBranch));
      if (divertedPath !== worktreePath) {
        // Through the same guard as the first reclaim — a recompute must not
        // grow a second, unguarded force-remove.
        worktreePath = reclaimOrDivert(divertedPath);
      }
    }

    console.log(`[Worker ${workerId}] Creating worktree: ${worktreePath} (branch: ${actualBranch}, base: ${base})`);

    // This worktree checks out `base` itself rather than cutting a new branch
    // from it — only true for a direct local-branch resume landing (see
    // `resumeFromLocalBranch` above). Every other shape creates `actualBranch`
    // fresh via `-b`.
    const checkoutExistingBranch = resumeFromLocalBranch && actualBranch === resumeCandidate;

    // Is local branch `ref` fully contained in (an ancestor of) `target`? Used
    // below to tell a genuinely stale branch (safe to delete — its commits are
    // already on `target`) from one carrying commits `target` doesn't have.
    // False — never an ancestor — for a nonexistent `ref` or `target`, which is
    // the conservative direction: an inconclusive answer must not be read as
    // "safe to delete".
    const isAncestorOf = (ref: string, target: string): boolean => {
      try {
        execSync(`git merge-base --is-ancestor "${ref}" "${target}"`, { ...execOpts, stdio: ['pipe', 'pipe', 'pipe'] });
        return true;
      } catch {
        return false;
      }
    };

    // Delete stale local branches from a previous run — but only when deleting
    // them cannot lose commits. `git branch -D` doesn't check merge status, so
    // the old unconditional version here deleted the ONLY ref holding a prior
    // attempt's unpushed commits right before recreating the same name fresh
    // from `base` (empty, if that attempt was killed before ever reaching
    // origin) — the exact bug `resumeFromLocalBranch` above exists to resume
    // from instead. Skip any candidate a live worktree holds (as before — `-D`
    // on those always fails) and, new: skip `resumeCandidate` itself whenever
    // we resumed from its local branch, since it IS `base` here — the worktree
    // add below reads it, whether by direct checkout or by cutting a fresh
    // branch from its tip, and either way it must still exist afterwards.
    for (const candidate of candidates) {
      if (branchOwners.has(candidate)) continue;
      if (resumeFromLocalBranch && candidate === resumeCandidate) continue;
      // `--is-ancestor` throws on every candidate that isn't already a local
      // branch, which in practice is nearly always.
      if (!localBranchExists(candidate)) continue;

      // Its remote tip may not be in a narrow (cloud) clone yet (a branch
      // restored from a park bundle, pushed by an earlier attempt): without it
      // pushed work reads as unpushed. A full clone: a no-op.
      ensureOriginBranch(repoPath, candidate, workerId);
      const safeToDelete =
        isAncestorOf(candidate, `origin/${defaultBranch}`) || isAncestorOf(candidate, `origin/${candidate}`);
      if (safeToDelete) {
        try {
          execSync(`git branch -D "${candidate}"`, { ...execOpts, stdio: ['pipe', 'pipe', 'pipe'] });
        } catch {
          // Branch doesn't exist locally — that's fine
        }
        continue;
      }

      // Not an ancestor of the default branch or of its own remote tip: this
      // local branch carries commits that exist nowhere else. Preserve them
      // under an orphan name instead of destroying the only ref that holds
      // them, and free up `candidate`'s name for `-b` to recreate below.
      const orphanName = `${candidate}-orphan-${workerId.slice(0, 8)}`;
      try {
        execSync(`git branch -m "${candidate}" "${orphanName}"`, { ...execOpts, stdio: ['pipe', 'pipe', 'pipe'] });
        const detail = `Renamed local branch "${candidate}" to "${orphanName}": it is not an ancestor of ` +
          `origin/${defaultBranch} or origin/${candidate}, so it carries commits pushed nowhere else.`;
        console.warn(`[Worker ${workerId}] ${detail}`);
        sessionLog(workerId, 'warn', 'stale_branch_preserved_unpushed', detail);
      } catch (err) {
        // Host -b fails if the ref remains. Cloud -B would overwrite it: fail
        // closed when the target still holds work we could not preserve.
        if (cloud && candidate === actualBranch && localBranchExists(candidate)) {
          throw new Error(`Cannot preserve unpushed branch "${candidate}" before checkout: ${errMessage(err)}`);
        }
      }
    }

    // stdio piped: git prints its own status line to stderr on a SUCCESSFUL
    // `worktree add` too, which duplicated the console.log the runner already
    // emits right after this call on every successful worker start. The
    // failure branch below still gets full stderr text via err.message —
    // piping only stops it from also going to the real log stream.
    emitPhase('worktree_start');
    emitWorktreeMode(cloud ? 'clone' : 'worktree');
    try {
      if (cloud) {
        execSync(checkoutExistingBranch
          ? `git checkout "${actualBranch}"`
          : `git checkout -B "${actualBranch}" "${base}"`, { ...execOpts, stdio: ['pipe', 'pipe', 'pipe'] });
      } else if (checkoutExistingBranch) {
        execSync(`git worktree add "${worktreePath}" "${actualBranch}"`, { ...execOpts, stdio: ['pipe', 'pipe', 'pipe'] });
      } else {
        execSync(`git worktree add -b "${actualBranch}" "${worktreePath}" "${base}"`, { ...execOpts, stdio: ['pipe', 'pipe', 'pipe'] });
        // `worktree add -b <new> <path> origin/<base>` makes git track the BASE
        // (branch.autoSetupMerge), so a plain `git push` fails with "upstream
        // branch name differs" — the push target must be the task's own branch.
        // Point the upstream at origin/<actualBranch> (it need not exist yet; a
        // push creates it), matching what `git push -u origin HEAD` would set.
        try {
          execSync(`git config "branch.${actualBranch}.remote" origin`, { ...execOpts, stdio: ['pipe', 'pipe', 'pipe'] });
          execSync(`git config "branch.${actualBranch}.merge" "refs/heads/${actualBranch}"`, { ...execOpts, stdio: ['pipe', 'pipe', 'pipe'] });
        } catch {
          // Best-effort: `git push origin HEAD` still works without it.
        }
      }
    } catch (err) {
      // Make the failure legible: name the branch and, when the branch namespace
      // is the cause, the worktree that holds it. Re-probe rather than trusting
      // the pre-flight map — another worker may have taken the branch in between.
      const holder = listBranchOwners(execOpts).get(actualBranch) ?? branchOwners.get(actualBranch);
      const detail = holder
        ? `branch "${actualBranch}" is already checked out in worktree ${holder}`
        : `branch "${actualBranch}" could not be created at ${worktreePath}`;
      throw new Error(
        `${cloud ? 'git checkout' : 'git worktree add'} failed: ${detail} (base ${base}): ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      emitPhase('worktree_end');
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
    const isDeclared = declared.source === 'manifest' && !!declared.manifest?.install?.command;
    // A cloud container installs every Node lockfile toolchain; a host runner, bun only.
    const installOpts: InstallOptions = cloud ? { allToolchains: true, timeoutMs: CLOUD_INSTALL_TIMEOUT_MS } : {};
    const deferredInstall = !isDeclared && setupOpts.deferInstall
      ? () => installWorkspaceDeps(worktreePath, workerId, installEnv, installOpts)
      : undefined;
    const install: InstallOutcome = isDeclared
      ? { status: 'skipped', reason: 'declared-manifest' }
      : deferredInstall
        ? { status: 'skipped', reason: 'deferred' }
        : await installWorkspaceDeps(worktreePath, workerId, installEnv, installOpts);

    console.log(`[Worker ${workerId}] Worktree ready at ${worktreePath}`);
    return {
      path: worktreePath,
      branch: actualBranch,
      base,
      install,
      ...(deferredInstall ? { deferredInstall } : {}),
      ...(fallback ? { fallback } : {}),
      ...(sharedBranch ? { sharedBranch } : {}),
      ...(staleBase ? { staleBase } : {}),
    };
  } catch (err) {
    console.error(`[Worker ${workerId}] Failed to set up worktree:`, err instanceof Error ? err.message : err);
    setupWorktreeErrors.set(workerId, (err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ').trim().slice(0, 400));
    // Clean up partial worktree
    try {
      if (!cloud && existsSync(worktreePath)) {
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
  if (resolve(repoPath) === resolve(worktreePath)) return;
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
  | { removed: false; reason: 'owned_by_live_worker' | 'unpushed_commits' | 'primary_clone' | 'archive_failed' };

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
  /** Where dirty/unpushed work is written before the tree goes. Default `~/.buildd/archive`. */
  archiveDir?: string;
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
  if (resolve(repoPath) === resolve(worktreePath)) return { removed: false, reason: 'primary_clone' };
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

function noteArchived(workerId: string, worktreePath: string, a: ArchiveResult): void {
  const where = [a.bundle, a.patch].filter(Boolean).join(', ');
  sessionLog(workerId, 'info', 'worktree_work_archived', `Archived work from ${worktreePath} before removal: ${where}`);
}

/**
 * Archive failed: the tree may hold work that exists nowhere else, so it stays.
 * Loud on purpose — a tree that cannot be archived is a leak the reaper retries,
 * and the alternative is the quiet loss this gate exists to prevent.
 */
function archiveRefusal(opts: RemoveWorktreeOptions, err: unknown): WorktreeRemovalOutcome {
  const why = err instanceof Error ? err.message.split('\n')[0] : String(err);
  const msg = `Kept worktree ${opts.worktreePath}: could not archive its work before removal (${why})`;
  sessionLog(opts.workerId, 'warn', 'worktree_removal_skipped_archive_failed', msg);
  console.warn(`[Worker ${opts.workerId}] ${msg}`);
  return { removed: false, reason: 'archive_failed' };
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
  if (existsSync(opts.worktreePath)) {
    try {
      const a = await archiveAsync(opts.worktreePath, opts.workerId, opts.archiveDir);
      if (a.archived) noteArchived(opts.workerId, opts.worktreePath, a);
    } catch (err) {
      return archiveRefusal(opts, err);
    }
  }
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
  if (existsSync(worktreePath)) {
    try {
      const a = archiveSync(worktreePath, workerId, opts.archiveDir);
      if (a.archived) noteArchived(workerId, worktreePath, a);
    } catch (err) {
      return archiveRefusal(opts, err);
    }
  }
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

  // cwd is the worker's own live worktree; this can run while the agent is
  // still staging/committing there. `diff`/`status` below would otherwise
  // opportunistically rewrite the on-disk index to cache fresh stat info,
  // taking index.lock and racing the agent's own git calls for it.
  // GIT_OPTIONAL_LOCKS=0 skips that write-back without changing any output
  // read here.
  const opts = { cwd, timeout: 5000, encoding: 'utf-8' as const, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } };
  const stats: Record<string, number | string | boolean | undefined> = {};

  // Resolve the ref this worktree's own commits are measured against.
  // Prefer the ref this worktree was actually cut from; a branch cut from a
  // mission integration branch must compare against THAT branch, not
  // dev/main/master — comparing against dev there reports the integration
  // branch's whole accumulated history as this worker's own, even when this
  // worker made zero commits of its own. Shared by the lastCommitSha trust
  // check below and the diff, which must agree on the same base.
  let mergeBase = '';
  // A narrow (cloud) clone may not hold the base: a resumed park restores the
  // worktree into a fresh clone of the default branch only. Fetched by name;
  // a full clone: a no-op.
  const baseBranch = branchOfRemoteRef(baseRef);
  if (baseBranch) ensureOriginBranch(cwd, baseBranch, workerId);
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
