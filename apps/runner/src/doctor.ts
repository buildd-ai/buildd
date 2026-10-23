/**
 * Runner self-diagnostics ("doctor") module.
 *
 * Checks the health of the runner environment and optionally uses Claude
 * to diagnose and fix issues it can't resolve with built-in logic.
 */

import { archiveWorktreeWorkSync } from './worktree-archive';
import { pruneLocalBranches } from './branch-prune';
import { execFileSync, execSync, spawnSync } from 'child_process';
import { existsSync, readdirSync, statSync, readFileSync, copyFileSync, truncateSync, rmSync, statfsSync } from 'fs';
import { tmpdir } from 'os';
import { basename, join } from 'path';
import { resolveBuilddHome } from './buildd-home';
import { isolationCheck, probeThisHost } from './isolation-check';
import { isolationVerdict } from '@buildd/shared';
import { backendLoginLines, resolveLaunchedCodexBinary } from './model-login-report';
import { NO_MODEL_AUTH_FIX, type MachineLoginProbe } from './host-seat';
import { resolveClaudeBinaryPath } from './sdk-binary-path';
import type { RunnerIsolationRecord } from '@buildd/shared';
import {
  parseWorktreeList,
  isRunnerWorktreePath,
  isWorktreePathOwnedByOtherLiveWorker,
  formatWorktreeTelemetry,
  shouldRemoveWorktree,
  classifyOwner,
  candidateRepoRoots,
  STALE_WORKTREE_IDLE_MS,
  type WorktreeOwnerRecord,
  type WorktreeOwnershipRecord,
  type WorktreeTelemetry,
} from './worktree-utils';
import { activityAt } from './worker-store';

// Resolved per call so a test runtime without a temp BUILDD_HOME fails closed
// (see buildd-home.ts) instead of inspecting or repairing the real install.
const builddDir = () => resolveBuilddHome();
const WORKER_STORE_TTL_MS = 24 * 60 * 60 * 1000; // mirrors worker-store MAX_AGE_MS
const BRANCH = process.env.BUILDD_BRANCH || 'main';
/**
 * Where an external wrapper redirects the runner's stdout/stderr: /tmp on
 * POSIX; the OS temp dir on Windows, where `/tmp` would mean `C:\tmp`.
 */
export function defaultRunnerLogPath(platform: NodeJS.Platform = process.platform, tmp: string = tmpdir()): string {
  return platform === 'win32' ? join(tmp, 'buildd.log') : '/tmp/buildd.log';
}
// Overridable for tests — production always redirects the runner's own
// stdout/stderr to this fixed path (an external wrapper, not this process).
const RUNNER_LOG_PATH = process.env.BUILDD_RUNNER_LOG_PATH || defaultRunnerLogPath();
const IS_WINDOWS = process.platform === 'win32';
/** For checks built on ps, screen or df, which a Windows host does not have. */
const notCheckedOnWindows = (name: string): CheckResult => ({ name, status: 'ok', message: 'Not checked on Windows' });
const RUNNER_LOG_ROTATE_MAX_BYTES = 5 * 1024 * 1024; // 5MB — grows ~0.5MB/day, so this is days of history per rotation

export type CheckStatus = 'ok' | 'warn' | 'error';

export interface CheckResult {
  name: string;
  status: CheckStatus;
  message: string;
  fixable?: boolean;
  detail?: string;
}

export interface DoctorReport {
  timestamp: string;
  checks: CheckResult[];
  summary: { ok: number; warn: number; error: number };
}

// --- Individual checks ---

/**
 * Informational only, never `fixable`. Moving the install tree (wrong branch
 * or behind origin) is the gated updater's job (`updater.ts` `applyUpdate`:
 * idle gate, `bun install`, health probe, restart). A doctor-side
 * `checkout -f && reset --hard` from the periodic self-heal was a fourth,
 * ungated update path that left the running process on a different tree.
 *
 * The messages promise nothing: the updater only moves the tree when it applies
 * an advertised update, and `BUILDD_DISABLE_AUTO_UPDATE` turns it off. So they
 * name the manual repair instead (also what `--doctor --fix` users need).
 */
function manualGitRepair(): string {
  return `not auto-fixed; to repair by hand: git -C ${builddDir()} checkout ${BRANCH} && git -C ${builddDir()} pull --ff-only, then restart the runner`;
}

export function checkGitState(): CheckResult {
  try {
    const head = execSync('git rev-parse HEAD', { cwd: builddDir(), encoding: 'utf-8', timeout: 5000, stdio: 'pipe' }).trim();
    const branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: builddDir(), encoding: 'utf-8', timeout: 5000, stdio: 'pipe' }).trim();

    if (branch !== BRANCH) {
      return {
        name: 'git-branch',
        status: 'error',
        message: `On branch '${branch}' instead of '${BRANCH}' (${manualGitRepair()})`,
      };
    }

    // Check if behind remote
    try {
      execSync(`git fetch origin ${BRANCH} --dry-run`, { cwd: builddDir(), encoding: 'utf-8', timeout: 15000, stdio: 'pipe' });
      const behind = execSync(`git rev-list HEAD..origin/${BRANCH} --count`, { cwd: builddDir(), encoding: 'utf-8', timeout: 5000, stdio: 'pipe' }).trim();
      if (parseInt(behind) > 0) {
        return {
          name: 'git-branch',
          status: 'warn',
          message: `${behind} commit(s) behind origin/${BRANCH} (${manualGitRepair()})`,
        };
      }
    } catch { /* fetch failed, non-fatal */ }

    return { name: 'git-branch', status: 'ok', message: `On ${BRANCH} at ${head.slice(0, 7)}` };
  } catch (err: any) {
    return { name: 'git-branch', status: 'error', message: `Git state unreadable: ${err.message}` };
  }
}

/**
 * Tracked modifications only (`-uno`). The fix restores tracked files, so
 * counting untracked entries made a stray untracked file re-trigger the fix on
 * every cycle without it ever sticking. Untracked files are reported
 * separately by `checkGitUntracked`, which is never fixable.
 */
export function checkGitDirty(): CheckResult {
  try {
    const status = execSync('git status --porcelain -uno -- apps/ packages/', { cwd: builddDir(), encoding: 'utf-8', timeout: 5000, stdio: 'pipe' }).trimEnd(); // not trim(): the XY column's leading space is significant
    if (status) {
      const lines = status.split('\n').filter(Boolean);
      return {
        name: 'git-clean',
        status: 'warn',
        message: `${lines.length} tracked file(s) modified`,
        detail: status,
        fixable: true,
      };
    }
    return { name: 'git-clean', status: 'ok', message: 'Working tree clean (tracked files)' };
  } catch {
    return { name: 'git-clean', status: 'error', message: 'Could not check git status' };
  }
}

/**
 * Informational: untracked files under apps/ or packages/ of the install tree.
 * Never fixable. Deleting files nobody committed is not a safe automatic
 * repair, and they don't affect what `git-clean` restores.
 */
export function checkGitUntracked(): CheckResult {
  try {
    const out = execSync('git ls-files --others --exclude-standard -- apps/ packages/', { cwd: builddDir(), encoding: 'utf-8', timeout: 5000, stdio: 'pipe' });
    const paths = out.split('\n').map(l => l.trim()).filter(Boolean);
    if (paths.length > 0) {
      const shown = paths.slice(0, 10).join(', ') + (paths.length > 10 ? `, +${paths.length - 10} more` : '');
      return {
        name: 'git-untracked',
        status: 'warn',
        message: `${paths.length} untracked file(s) in the install tree (not auto-fixed): ${shown}`,
        detail: paths.join('\n'),
      };
    }
    return { name: 'git-untracked', status: 'ok', message: 'No untracked files in apps/ or packages/' };
  } catch {
    return { name: 'git-untracked', status: 'ok', message: 'Could not list untracked files (non-fatal)' };
  }
}

function checkBunInstall(): CheckResult {
  if (IS_WINDOWS) return notCheckedOnWindows('bun-install');
  try {
    // Check for lock conflicts — is another bun install running?
    const ps = execSync("ps aux | grep 'bun install' | grep -v grep", { encoding: 'utf-8', timeout: 5000, stdio: 'pipe' }).trim();
    const lines = ps.split('\n').filter(Boolean);

    // Filter out our own process
    const otherInstalls = lines.filter(l => !l.includes('doctor'));
    if (otherInstalls.length > 0) {
      return {
        name: 'bun-install',
        status: 'error',
        message: `${otherInstalls.length} other bun install process(es) running — may block updates`,
        detail: otherInstalls.join('\n'),
        fixable: true,
      };
    }
    return { name: 'bun-install', status: 'ok', message: 'No competing bun install processes' };
  } catch {
    // grep returns exit 1 when no matches — that's good
    return { name: 'bun-install', status: 'ok', message: 'No competing bun install processes' };
  }
}

function diskUsedPct(): number {
  if (IS_WINDOWS) {
    const s = statfsSync(builddDir());
    return Math.round(100 * (1 - s.bavail / s.blocks));
  }
  const df = execSync("df -h . | tail -1", { cwd: builddDir(), encoding: 'utf-8', timeout: 5000, stdio: 'pipe' }).trim();
  return parseInt(df.split(/\s+/)[4]); // e.g. "66%"
}

function checkDiskUsage(): CheckResult {
  try {
    const usedPct = diskUsedPct();
    if (!Number.isFinite(usedPct)) throw new Error('no usage figure');
    if (usedPct >= 90) {
      return { name: 'disk-usage', status: 'error', message: `Disk ${usedPct}% full`, fixable: true };
    }
    if (usedPct >= 75) {
      return { name: 'disk-usage', status: 'warn', message: `Disk ${usedPct}% full`, fixable: true };
    }
    return { name: 'disk-usage', status: 'ok', message: `Disk ${usedPct}% used` };
  } catch {
    return { name: 'disk-usage', status: 'warn', message: 'Could not check disk usage' };
  }
}

// ─── Worktree sweep (git-authoritative) ──────────────────────────────────────
//
// The runner leaks per-task worktrees under many locations — the buildd
// self-repo (`~/.buildd`), role checkouts (`~/.buildd/roles/*`), and workspace
// repos (`~/project/*`). The old sweep hard-coded `~/project/*/.buildd-worktrees`
// and so was blind to the builder-role worktrees that actually accumulated.
//
// Instead we enumerate worktrees authoritatively with `git worktree list
// --porcelain` from every main repo we can find — this reports every worktree
// regardless of where it physically lives — and gate removal on safety rules
// (see shouldRemoveWorktree): never touch a live worker's tree, only force-
// remove terminal tasks whose branch is pushed, and reclaim true orphans.

interface RemovableWorktree {
  repoDir: string; // main repo to run git from
  path: string;
  branch: string;
  ageMs: number;
  reason: string;
}

/** Read a directory, returning [] on any error. */
function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** Discover candidate "main" git repos whose worktrees we should sweep. */
function discoverMainRepos(): string[] {
  return candidateRepoRoots({
    builddDir: builddDir(),
    projectDir: join(builddDir(), '..', 'project'),
    isGitRepo: (dir: string) => existsSync(join(dir, '.git')),
    listDir: safeReaddir,
    joinPath: join,
  });
}

/**
 * Load persisted worker records (BUILDD_DIR/workers/*.json), dropping any older
 * than the store's 24h TTL — those are exactly the records that would be gone
 * on restart, so their worktrees are treated as unowned orphans.
 */
function loadOwnerRecords(): WorktreeOwnerRecord[] {
  const dir = join(builddDir(), 'workers');
  const now = Date.now();
  const out: WorktreeOwnerRecord[] = [];
  for (const f of safeReaddir(dir)) {
    if (!f.endsWith('.json') || f.endsWith('.tmp')) continue;
    try {
      const data = JSON.parse(readFileSync(join(dir, f), 'utf-8'));
      // Same activity-age rule as the store itself (worker-store.activityAt).
      // A `_savedAt` comparison here would have doctor and the store disagree
      // about which files still exist, because `_savedAt` is the write time and
      // gets re-stamped by every persist.
      const age = activityAt(data);
      if (age && now - age > WORKER_STORE_TTL_MS) continue;
      out.push({
        status: data.status,
        worktreePath: data.worktreePath,
        branch: data.branch,
        lastActivity: data.lastActivity,
      });
    } catch { /* skip malformed */ }
  }
  return out;
}

/** Has this branch been pushed to origin (no unpushed commits)? */
function isBranchPushed(repoDir: string, branch: string): boolean {
  const opts = { cwd: repoDir, encoding: 'utf-8' as const, timeout: 5000, stdio: 'pipe' as const };
  try {
    execSync(`git rev-parse --verify --quiet "refs/remotes/origin/${branch}"`, opts);
  } catch {
    return false; // no remote branch → not pushed
  }
  try {
    const unpushed = execSync(`git rev-list --count "origin/${branch}..${branch}"`, opts).trim();
    return parseInt(unpushed, 10) === 0;
  } catch {
    return false;
  }
}

/** What the sweep saw this pass, alongside what it may remove. */
interface SweepScan {
  removable: RemovableWorktree[];
  telemetry: WorktreeTelemetry;
}

/**
 * The live in-memory worker view, when the sweep runs in-process from
 * `runCleanup`. Persisted records are written on a cadence, so a worker whose
 * JSON write lagged would otherwise classify as `orphan` — the same predicate
 * every teardown path uses is the second line of defence. Omitted by the CLI,
 * which has no in-memory map and falls back to records only.
 */
export type LiveWorkerView = Iterable<[string, WorktreeOwnershipRecord]>;

/** Never clear a host in one pass — a misclassification must stay survivable. */
const MAX_REAP_PER_TICK = 10;

function scanWorktrees(liveWorkers?: LiveWorkerView): SweepScan {
  const repos = discoverMainRepos();
  const records = loadOwnerRecords();
  const seen = new Set<string>();
  const removable: RemovableWorktree[] = [];
  const telemetry: WorktreeTelemetry = {
    repos: repos.length, worktrees: 0, live: 0, terminal: 0, orphan: 0,
    removable: 0, diskMB: 0, reaped: 0, skippedOwned: 0,
  };
  const live = liveWorkers ? [...liveWorkers] : null;

  for (const repoDir of repos) {
    let porcelain = '';
    try {
      porcelain = execSync('git worktree list --porcelain', {
        cwd: repoDir, encoding: 'utf-8', timeout: 10000, stdio: 'pipe',
      });
    } catch { continue; }

    // Size `.buildd-worktrees` once per repo rather than once per worktree, so
    // the per-tick cost stays flat as worktrees accumulate.
    telemetry.diskMB += dirSizeMB(join(repoDir, '.buildd-worktrees'));

    for (const wt of parseWorktreeList(porcelain)) {
      if (wt.path === repoDir || seen.has(wt.path)) continue; // skip main worktree + dupes
      // Location, not branch name — and never a worktree outside our own
      // directory (a human feature branch, or an SDK `isolation: 'worktree'`
      // subagent tree, is not ours to reap).
      if (!isRunnerWorktreePath(wt.path)) continue;
      seen.add(wt.path);
      telemetry.worktrees++;

      let ageMs: number;
      try {
        ageMs = Date.now() - statSync(wt.path).mtimeMs;
      } catch {
        ageMs = Infinity; // dir gone but ref lingers → prunable
      }

      // A detached worktree has no branch. `classifyOwner` matches on path in
      // that case and `isBranchPushed` cannot answer, so an unpushed-work check
      // is impossible — which shouldRemoveWorktree already treats as "retain".
      const branch = wt.branch ?? '';
      const owner = classifyOwner(records, wt.path, branch);
      telemetry[owner]++;

      if (live && isWorktreePathOwnedByOtherLiveWorker(live, wt.path, '__sweep__')) {
        // Beats the record-based classification: the store write may simply
        // not have happened yet.
        telemetry.skippedOwned++;
        continue;
      }

      const branchPushed = owner === 'orphan'
        ? true
        : branch !== '' && isBranchPushed(repoDir, branch);
      const decision = shouldRemoveWorktree({
        idleMs: ageMs,
        idleThresholdMs: STALE_WORKTREE_IDLE_MS,
        owner,
        branchPushed,
      });
      if (decision.remove) {
        removable.push({ repoDir, path: wt.path, branch, ageMs, reason: decision.reason });
      }
    }
  }
  telemetry.removable = removable.length;
  return { removable, telemetry };
}

/**
 * Enumerate leftover runner worktrees across all discovered repos and return
 * those that pass the safety gates for removal. Shared by the check (report)
 * and the fix (remove) so they can never disagree.
 */
function findRemovableWorktrees(): RemovableWorktree[] {
  return scanWorktrees().removable;
}

function dirSizeMB(path: string): number {
  // No du on Windows: sizes read 0 there rather than walking a big tree in-thread.
  if (IS_WINDOWS) return 0;
  try {
    const du = execSync(`du -sm "${path}" 2>/dev/null | cut -f1`, { encoding: 'utf-8', timeout: 10000, stdio: 'pipe' }).trim();
    return parseInt(du) || 0;
  } catch {
    return 0;
  }
}

export function checkStaleWorktrees(): CheckResult {
  let removable: RemovableWorktree[];
  try {
    removable = findRemovableWorktrees();
  } catch {
    return { name: 'stale-worktrees', status: 'ok', message: 'Worktree scan failed (non-fatal)' };
  }

  if (removable.length === 0) {
    return { name: 'stale-worktrees', status: 'ok', message: 'No stale worktrees' };
  }

  let totalSizeMB = 0;
  const staleDetails = removable.map(w => {
    totalSizeMB += dirSizeMB(w.path);
    const age = w.ageMs === Infinity ? 'missing' : `${Math.round(w.ageMs / 3600000)}h`;
    return `${w.path} (${age}, ${w.reason})`;
  });

  return {
    name: 'stale-worktrees',
    status: totalSizeMB > 500 ? 'error' : 'warn',
    message: `${removable.length} stale worktree(s) using ~${totalSizeMB}MB`,
    detail: staleDetails.join('\n'),
    fixable: true,
  };
}

/**
 * The runtime's isolation verdict for this host (R-8): the same record and
 * text as the heartbeat and Health. The in-process callers pass the runner's
 * own record, so a runtime bwrap denial shows here too.
 */
export function checkIsolation(record?: RunnerIsolationRecord): CheckResult {
  return isolationCheck(record ?? probeThisHost());
}

export interface BackendCheckOpts {
  /** Login probe (env, home); defaults to this process. Injected in tests. */
  probe?: MachineLoginProbe;
  /** Path of the program the runner launches, or null/undefined when missing. Injected in tests. */
  program?: string | null;
  isolation?: RunnerIsolationRecord;
}

function backendConfinement(record: RunnerIsolationRecord | undefined, backend: 'claude' | 'codex'): string {
  const lines = isolationVerdict(record ?? probeThisHost()).backends.filter((b) => b.backend === backend).map((b) => b.line);
  return lines.join('; ');
}

/**
 * One line per agent backend (login spec R-14 to R-18): the program the runner
 * launches, which login it uses, and its confinement. Labels only; the login
 * comes from the same detector as startup and the heartbeat, and nothing here
 * calls a model.
 */
export function checkClaudeBackend(opts: BackendCheckOpts = {}): CheckResult {
  const program = 'program' in opts ? opts.program : resolveClaudeBinaryPath();
  const login = backendLoginLines(opts.probe).find((l) => l.backend === 'claude')!;
  const sandbox = backendConfinement(opts.isolation, 'claude');
  const message = `${login.text}. Sandbox: ${sandbox}`;
  if (!program) {
    return {
      name: 'claude', status: 'error',
      message: `Claude CLI not found; the runner cannot start Claude tasks. ${message}`,
      detail: 'Reinstall the runner dependencies: run `bun install` in the buildd checkout.',
    };
  }
  if (login.label === 'none') {
    return { name: 'claude', status: 'warn', message, detail: `To fix: ${NO_MODEL_AUTH_FIX}` };
  }
  return { name: 'claude', status: 'ok', message };
}

export function checkCodexBackend(opts: BackendCheckOpts = {}): CheckResult {
  const program = 'program' in opts ? opts.program : resolveLaunchedCodexBinary();
  const login = backendLoginLines(opts.probe).find((l) => l.backend === 'codex')!;
  const sandbox = backendConfinement(opts.isolation, 'codex');
  const message = `${login.text}. Sandbox: ${sandbox}`;
  if (!program) {
    return {
      name: 'codex', status: 'warn',
      message: `Bundled Codex binary not found; Codex tasks will not run here. ${message}`,
      detail: 'Reinstall the runner dependencies (`bun install`) so @openai/codex-sdk brings its binary.',
    };
  }
  // A missing Codex login is not a warning: Codex is optional. The fix is in the words.
  return { name: 'codex', status: 'ok', message };
}

function checkScreenSession(): CheckResult {
  if (IS_WINDOWS) return notCheckedOnWindows('screen-session');
  try {
    const screens = execSync('screen -ls 2>&1', { encoding: 'utf-8', timeout: 5000, stdio: 'pipe' });
    if (screens.includes('buildd')) {
      return { name: 'screen-session', status: 'ok', message: 'Screen session "buildd" active' };
    }
    return { name: 'screen-session', status: 'warn', message: 'No "buildd" screen session found' };
  } catch {
    return { name: 'screen-session', status: 'ok', message: 'Screen not available (may be running directly)' };
  }
}

function isRunnerNeverStarted(): boolean {
  const dbPath = join(builddDir(), 'history.db');
  const walPath = join(builddDir(), 'history.db-wal');
  const logPath = process.env.BUILDD_RUNNER_LOG_PATH || RUNNER_LOG_PATH;
  return !existsSync(dbPath) && !existsSync(walPath) && !existsSync(logPath);
}

function checkRunnerProcess(): CheckResult {
  if (IS_WINDOWS) return notCheckedOnWindows('runner-process');
  try {
    const ps = execSync("ps aux | grep 'bun run apps/runner' | grep -v grep", { encoding: 'utf-8', timeout: 5000, stdio: 'pipe' }).trim();
    if (ps) {
      return { name: 'runner-process', status: 'ok', message: 'Runner process running' };
    }
    if (isRunnerNeverStarted()) {
      return { name: 'runner-process', status: 'ok', message: 'Runner not started yet. Start it with `buildd`.' };
    }
    return { name: 'runner-process', status: 'error', message: 'Runner process not found' };
  } catch {
    // grep exit 1 = no match
    if (isRunnerNeverStarted()) {
      return { name: 'runner-process', status: 'ok', message: 'Runner not started yet. Start it with `buildd`.' };
    }
    return { name: 'runner-process', status: 'error', message: 'Runner process not found', fixable: true };
  }
}

function checkConfig(): CheckResult {
  const configPath = join(builddDir(), 'config.json');
  try {
    const raw = readFileSync(configPath, 'utf-8');
    const config = JSON.parse(raw);

    const issues: string[] = [];
    // API key can come from config or BUILDD_API_KEY env var
    if (!config.apiKey && !config.token && !process.env.BUILDD_API_KEY) {
      issues.push('no auth credentials');
    }
    if (!config.pusherKey) issues.push('no Pusher key (no real-time updates)');

    if (issues.length > 0) {
      return {
        name: 'config',
        status: issues.some(i => i.includes('auth')) ? 'error' : 'warn',
        message: issues.join(', '),
      };
    }
    return { name: 'config', status: 'ok', message: 'Config valid' };
  } catch (err: any) {
    return { name: 'config', status: 'error', message: `Config unreadable: ${err.message}` };
  }
}

export interface RotateResult {
  rotated: boolean;
  sizeBefore: number;
}

/**
 * Copy-then-truncate rotation, not rename-then-recreate: the log file is
 * stdout redirected by an external wrapper (`>> logPath`) that holds the fd
 * open for the runner's whole lifetime. Renaming the path away wouldn't give
 * that still-running process a new fd at the old name — nothing would exist
 * there again until the process restarts. Truncating in place is safe for an
 * O_APPEND writer (every write() re-seeks to EOF first), so the next append
 * after truncateSync(path, 0) correctly resumes from offset 0 with no gap.
 *
 * Keeps exactly one prior rotation (`<path>.1`) rather than a full history —
 * this is a bound on a single ever-growing file, not the forensic archive
 * (that's claims.log, which this never touches: different file, different
 * directory, never passed here).
 */
export function rotateLogIfLarge(path: string, maxBytes: number): RotateResult {
  if (!existsSync(path)) return { rotated: false, sizeBefore: 0 };
  const sizeBefore = statSync(path).size;
  if (sizeBefore < maxBytes) return { rotated: false, sizeBefore };
  try {
    copyFileSync(path, `${path}.1`);
    truncateSync(path, 0);
  } catch {
    return { rotated: false, sizeBefore };
  }
  return { rotated: true, sizeBefore };
}

/**
 * The last `n` lines of a file, like `tail -n`. Reads the whole file: the
 * runner log is rotated at RUNNER_LOG_ROTATE_MAX_BYTES before this runs.
 */
export function tailLines(path: string, n: number): string {
  const lines = readFileSync(path, 'utf-8').split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines.slice(-n).join('\n') + '\n';
}

function checkRunnerLog(): CheckResult {
  const logPath = process.env.BUILDD_RUNNER_LOG_PATH || RUNNER_LOG_PATH;
  try {
    if (!existsSync(logPath)) {
      if (isRunnerNeverStarted()) {
        return { name: 'runner-log', status: 'ok', message: 'Runner not started yet. Start it with `buildd`.' };
      }
      // TODO: detect if runner runs as service and suggest 'buildd service logs'
      return { name: 'runner-log', status: 'warn', message: `No runner log at ${logPath}` };
    }

    // Proactive, size-triggered rotation on every doctor cycle — decoupled
    // from the crash/update-loop detection below, which used to be the only
    // trigger for touching this file (and only "fixed" it by clearing it).
    rotateLogIfLarge(logPath, RUNNER_LOG_ROTATE_MAX_BYTES);

    const tail = tailLines(logPath, 50);

    // Detect auto-update loop
    const updateLines = tail.split('\n').filter(l => l.includes('Auto-updating after'));
    if (updateLines.length >= 5) {
      return {
        name: 'runner-log',
        status: 'error',
        message: `Auto-update loop detected (${updateLines.length} retries in recent log)`,
        detail: tail,
        fixable: true,
      };
    }

    // Detect crash loops
    const restartLines = tail.split('\n').filter(l => l.includes('restarting in 5s'));
    if (restartLines.length >= 3) {
      return {
        name: 'runner-log',
        status: 'error',
        message: `Crash loop detected (${restartLines.length} restarts in recent log)`,
        detail: tail,
      };
    }

    return { name: 'runner-log', status: 'ok', message: 'No issues in recent log' };
  } catch {
    return { name: 'runner-log', status: 'warn', message: 'Could not read runner log' };
  }
}

function checkHistoryDb(): CheckResult {
  const dbPath = join(builddDir(), 'history.db');
  const walPath = join(builddDir(), 'history.db-wal');

  try {
    if (!existsSync(dbPath)) {
      return { name: 'history-db', status: 'ok', message: 'History database created on first run' };
    }

    const dbSize = statSync(dbPath).size;
    const walSize = existsSync(walPath) ? statSync(walPath).size : 0;
    const totalMB = Math.round((dbSize + walSize) / 1024 / 1024);

    if (totalMB > 100) {
      return {
        name: 'history-db',
        status: 'warn',
        message: `History DB is ${totalMB}MB (db: ${Math.round(dbSize / 1024 / 1024)}MB, WAL: ${Math.round(walSize / 1024 / 1024)}MB)`,
        fixable: true,
      };
    }
    return { name: 'history-db', status: 'ok', message: `History DB ${totalMB}MB` };
  } catch {
    return { name: 'history-db', status: 'warn', message: 'Could not check history database' };
  }
}

// --- Fix functions ---

export interface FixResult {
  check: string;
  success: boolean;
  message: string;
  /** Only on the worktree sweep: the per-tick inventory, always populated. */
  telemetry?: WorktreeTelemetry;
}

/** Paths from `git status --porcelain` lines (`XY path` / `XY old -> new`). */
function porcelainPaths(detail: string | undefined): string[] {
  if (!detail) return [];
  return detail.split('\n').map(l => l.slice(3).trim()).filter(Boolean);
}

function fixGitClean(check: CheckResult): FixResult {
  // Name what gets discarded: the self-heal log is the only record of it.
  const paths = porcelainPaths(check.detail);
  const named = paths.length > 0 ? `: ${paths.join(', ')}` : '';
  try {
    // Restore from HEAD, not the index: `git checkout -- <path>` copies the
    // index to the worktree, so staged edits and staged additions survived it
    // and the check re-fired every cycle. `restore` (no-overlay) also drops
    // staged additions.
    execSync('git restore --source=HEAD --staged --worktree -- apps/ packages/', { cwd: builddDir(), encoding: 'utf-8', timeout: 10000, stdio: 'pipe' });
    // Report what's true afterwards, not what the command intended.
    const after = checkGitDirty();
    if (after.status !== 'ok') {
      return { check: 'git-clean', success: false, message: `Restore ran but tree is still dirty (${after.message})${named}` };
    }
    return { check: 'git-clean', success: true, message: `Restored ${paths.length} tracked file(s)${named}` };
  } catch (err: any) {
    return { check: 'git-clean', success: false, message: `${err.message}${named}` };
  }
}

function fixBunInstall(): FixResult {
  try {
    // Kill competing bun install processes (not ours)
    const myPid = process.pid;
    execSync(`ps aux | grep 'bun install' | grep -v grep | awk '{print $2}' | grep -v ${myPid} | xargs -r kill 2>/dev/null`, {
      encoding: 'utf-8', timeout: 5000, stdio: 'pipe',
    });
    return { check: 'bun-install', success: true, message: 'Killed competing bun install processes' };
  } catch {
    return { check: 'bun-install', success: true, message: 'No processes to kill' };
  }
}

/**
 * Remove a worktree via git (which also drops its .git/worktrees/ admin
 * entry), else delete the directory. Argv git and fs, no shell: the old
 * `... 2>/dev/null` / `rm -rf` lines both failed under cmd.exe on Windows.
 * Best effort; never throws. The caller prunes dangling admin entries.
 */
export function removeWorktreeDir(repoDir: string, path: string): void {
  try {
    execFileSync('git', ['worktree', 'remove', '--force', path], { cwd: repoDir, encoding: 'utf-8', timeout: 10000, stdio: 'pipe', windowsHide: true });
  } catch {
    try { rmSync(path, { recursive: true, force: true }); } catch { /* skip */ }
  }
}

export function fixStaleWorktrees(liveWorkers?: LiveWorkerView): FixResult {
  let scan: SweepScan;
  try {
    scan = scanWorktrees(liveWorkers);
  } catch {
    return { check: 'stale-worktrees', success: true, message: 'Worktree scan failed (non-fatal)' };
  }

  let cleaned = 0;
  let freedMB = 0;

  for (const w of scan.removable.slice(0, MAX_REAP_PER_TICK)) {
    freedMB += dirSizeMB(w.path);
    // Log before removing, so a misclassification is diagnosable after the fact
    // rather than only inferable from an absence.
    console.log(
      `[worktree-sweep] removing ${w.path} (branch=${w.branch || '<detached>'}, ` +
      `idle=${Math.round(w.ageMs / 60000)}m, reason=${w.reason})`,
    );
    // `worktree remove --force` exits 0 on a dirty tree: archive first, and
    // keep the tree if the archive can't be written.
    try {
      if (existsSync(w.path)) {
        const a = archiveWorktreeWorkSync(w.path, basename(w.path));
        if (a.archived) console.log(`[worktree-sweep] archived work from ${w.path}: ${[a.bundle, a.patch].filter(Boolean).join(', ')}`);
      }
    } catch (err) {
      console.warn(`[worktree-sweep] keeping ${w.path}: archive failed — ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
      continue;
    }
    removeWorktreeDir(w.repoDir, w.path);
    cleaned++;
  }
  scan.telemetry.reaped = cleaned;

  // Prune dangling worktree refs (covers rm -rf fallback + externally deleted dirs).
  const repoDirs = discoverMainRepos();
  for (const repoDir of repoDirs) {
    try {
      execSync('git worktree prune', { cwd: repoDir, encoding: 'utf-8', timeout: 5000, stdio: 'pipe' });
    } catch { /* skip */ }
  }

  // Delete stale local buildd/* branches (bloated .git/config makes parallel
  // worker starts lose the config lock race). Branches of any non-terminal
  // worker, persisted or in memory, are protected.
  const protectedBranches = new Set<string>();
  for (const r of loadOwnerRecords()) {
    if (r.branch && r.status !== 'done' && r.status !== 'error') protectedBranches.add(r.branch);
  }
  if (liveWorkers) {
    for (const [, w] of liveWorkers) {
      const b = (w as { branch?: string }).branch;
      if (b && w.status !== 'done' && w.status !== 'error') protectedBranches.add(b);
    }
  }
  scan.telemetry.branchesPruned = 0;
  scan.telemetry.seedRemoved = 0;
  for (const repoDir of repoDirs) {
    try {
      const r = pruneLocalBranches(repoDir, { protectedBranches });
      scan.telemetry.branchesPruned += r.branchesPruned;
      scan.telemetry.seedRemoved += r.seedWorktreesRemoved;
    } catch { /* best effort */ }
  }

  return {
    check: 'stale-worktrees',
    success: true,
    message: cleaned > 0 ? `Removed ${cleaned} stale worktree(s), freed ~${freedMB}MB` : 'No stale worktrees to clean',
    telemetry: scan.telemetry,
  };
}

function fixDiskUsage(): FixResult {
  // Clean known disk hogs: archive, old logs, bun cache
  let freedMB = 0;
  const actions: string[] = [];

  // Clean archive (completed worker data)
  const archiveDir = join(builddDir(), 'archive');
  if (existsSync(archiveDir)) {
    try {
      const du = execSync(`du -sm "${archiveDir}" | cut -f1`, { encoding: 'utf-8', timeout: 10000, stdio: 'pipe' }).trim();
      const sizeMB = parseInt(du) || 0;
      if (sizeMB > 50) {
        // Keep last 100 entries, remove the rest
        const entries = readdirSync(archiveDir).sort();
        const toRemove = entries.slice(0, -100);
        for (const entry of toRemove) {
          try {
            rmSync(join(archiveDir, entry), { force: true });
          } catch { /* skip */ }
        }
        actions.push(`trimmed archive (kept 100, removed ${toRemove.length})`);
        freedMB += Math.round(sizeMB * (toRemove.length / entries.length));
      }
    } catch { /* skip */ }
  }

  // Clean old logs (keep last 50)
  const logsDir = join(builddDir(), 'logs');
  if (existsSync(logsDir)) {
    try {
      const logFiles = readdirSync(logsDir)
        .filter(f => f.endsWith('.log') && f !== 'claims.log')
        .map(f => ({ name: f, mtime: statSync(join(logsDir, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);

      const toRemove = logFiles.slice(50);
      for (const f of toRemove) {
        try { rmSync(join(logsDir, f.name), { force: true }); } catch { /* skip */ }
      }
      if (toRemove.length > 0) actions.push(`removed ${toRemove.length} old log files`);
    } catch { /* skip */ }
  }

  // Clean stale worktrees (delegate)
  const wtResult = fixStaleWorktrees();
  if (wtResult.message.includes('Removed')) actions.push(wtResult.message);

  return {
    check: 'disk-usage',
    success: true,
    message: actions.length > 0 ? actions.join('; ') : 'No obvious disk savings found',
  };
}

function fixHistoryDb(): FixResult {
  const dbPath = join(builddDir(), 'history.db');
  try {
    // WAL checkpoint to consolidate WAL into main db
    execSync(`sqlite3 "${dbPath}" "PRAGMA wal_checkpoint(TRUNCATE);"`, {
      encoding: 'utf-8', timeout: 10000, stdio: 'pipe',
    });
    return { check: 'history-db', success: true, message: 'Checkpointed WAL into main database' };
  } catch {
    return { check: 'history-db', success: false, message: 'sqlite3 not available or checkpoint failed' };
  }
}

function fixRunnerLog(): FixResult {
  // Auto-update/crash loop detection itself is unaffected by this — this only
  // stops the log from growing unbounded. Previously this cleared the file
  // outright (`echo ... > logPath`), destroying the forensic record instead
  // of preserving it; force a rotation now instead, keeping the content in
  // `<path>.1` rather than discarding it.
  try {
    const result = rotateLogIfLarge(RUNNER_LOG_PATH, 0);
    return {
      check: 'runner-log',
      success: true,
      message: result.rotated ? `Rotated runner log (${result.sizeBefore} bytes preserved in ${RUNNER_LOG_PATH}.1)` : 'Runner log empty, nothing to rotate',
    };
  } catch (err: any) {
    return { check: 'runner-log', success: false, message: err?.message || 'Could not rotate runner log' };
  }
}

// No 'git-branch' entry: see checkGitState. Install-tree moves belong to the
// gated updater only.
const fixMap: Record<string, (check: CheckResult) => FixResult> = {
  'git-clean': fixGitClean,
  'bun-install': fixBunInstall,
  'stale-worktrees': () => fixStaleWorktrees(),
  'disk-usage': fixDiskUsage,
  'history-db': fixHistoryDb,
  'runner-log': fixRunnerLog,
};

// --- Main doctor function ---

export function runDiagnostics(opts: {
  isolation?: RunnerIsolationRecord;
  /**
   * The runner-process line, when the caller knows better than a `ps` match:
   * the runner itself (is its socket answering, runner-socket.ts
   * socketHealthCheck) or `--doctor` (did the socket probe find a runner). The
   * ps pattern misses a runner started by launchd or systemd, so on its own it
   * reported a running runner as missing.
   */
  runnerProcess?: CheckResult;
  /** Per-backend overrides for tests. */
  backends?: { claude?: BackendCheckOpts; codex?: BackendCheckOpts };
} = {}): DoctorReport {
  const record = opts.isolation ?? probeThisHost();
  const checks = [
    opts.runnerProcess ?? checkRunnerProcess(),
    checkConfig(),
    checkGitState(),
    checkGitDirty(),
    checkGitUntracked(),
    checkBunInstall(),
    checkIsolation(record),
    checkClaudeBackend({ isolation: record, ...opts.backends?.claude }),
    checkCodexBackend({ isolation: record, ...opts.backends?.codex }),
    checkScreenSession(),
    checkRunnerLog(),
    checkDiskUsage(),
    checkStaleWorktrees(),
    checkHistoryDb(),
  ];

  const summary = {
    ok: checks.filter(c => c.status === 'ok').length,
    warn: checks.filter(c => c.status === 'warn').length,
    error: checks.filter(c => c.status === 'error').length,
  };

  return {
    timestamp: new Date().toISOString(),
    checks,
    summary,
  };
}

export function autoFix(report: DoctorReport): FixResult[] {
  const results: FixResult[] = [];

  for (const check of report.checks) {
    if ((check.status === 'error' || check.status === 'warn') && check.fixable) {
      const fixer = fixMap[check.name];
      if (fixer) {
        results.push(fixer(check));
      }
    }
  }

  return results;
}

