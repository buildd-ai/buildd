/**
 * A service stop or restart pauses running agents, and the next start
 * continues them in their own sessions (Living Spec "Runner on your
 * terminal", R-37 and R-38).
 *
 * Two halves, both here so they agree on one rule:
 *
 *  - Shutdown (SIGTERM/SIGINT from the service manager or Ctrl-C, and the
 *    self-update restart): every running agent is paused the way `p` does,
 *    within a bounded grace. One that has not reached a safe point by then
 *    (a tool still running) is stopped anyway, and its worktree changes are
 *    committed to its own branch as a local checkpoint. Nothing is pushed: the
 *    branch is the agent's own and the existing push rules still decide what
 *    reaches GitHub. The grace is shorter than the service manager's kill
 *    timeout, so the runner always exits on its own (SHUTDOWN_DEADLINE_MS).
 *
 *  - Start: a worker the runner paused, or one it was running when the
 *    process died with no grace at all (SIGKILL, power loss), is restored as
 *    paused when its worktree and its session (the Claude transcript, or the
 *    Codex thread) are still on disk, and continued in that session unless the
 *    runner is on hold. When one of them is gone it cannot continue where it
 *    was, so its task starts again as a new attempt from its last pushed
 *    commit, and the reason names what was missing. A worker whose worktree
 *    and session still exist is never failed as "Process restarted".
 *
 * Pure decisions and bounded I/O; WorkerManager / WorkerSync do the wiring.
 */
// Namespace import: many runner tests mock.module('fs') with a partial stub;
// through the namespace a missing member is a caught TypeError, not a link error.
import * as fs from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type { LocalWorker } from './types';
import { gitArgsAsync } from './git-async';
import { stableCodexHomePath } from './codex-auth';
import { isolatedClaudeConfigDirPath, stableCodexHomeIsolatedPath } from './isolation-paths';

// ── the grace ───────────────────────────────────────────────────────────────

/**
 * How long a stop waits for each running agent to reach a safe point (no tool
 * executing) before stopping it anyway.
 */
export const SHUTDOWN_SAFE_POINT_MS = 10_000;
/** The checkpoint commit of an agent stopped mid-tool, all its git commands together. */
export const SHUTDOWN_CHECKPOINT_MS = 4_000;
/**
 * The runner exits by this long after the signal whatever is still pending, so
 * a hung agent or a hung git never blocks a shutdown. Under launchd's default
 * ExitTimeOut (20 s), which older installs still have; the service units this
 * runner writes give it 30 s (service.ts SERVICE_STOP_TIMEOUT_S).
 */
export const SHUTDOWN_DEADLINE_MS = 17_000;

// ── what a restart needs to continue a session ──────────────────────────────

export interface ResumeProbe {
  /** The worktree directory still exists. */
  worktreeExists(path: string): boolean;
  /** Claude: a transcript for this session id under one of the config dirs. */
  claudeSessionExists(sessionId: string, worker?: Pick<LocalWorker, 'id' | 'workspaceId'>): boolean;
  /** Codex: a rollout for this thread under the worker's stable CODEX_HOME. */
  codexThreadExists(worker: Pick<LocalWorker, 'id' | 'workspaceId'>, threadId: string): boolean;
}

export type RestoreVerdict =
  | { kind: 'continue' }
  | { kind: 'new_attempt'; missing: string[] };

const ID_RE = /^[A-Za-z0-9_-]{6,128}$/;

/** Claude config dirs a host session may have written its transcript under. */
export function claudeConfigDirs(env: Record<string, string | undefined> = process.env): string[] {
  return [...new Set([env.CLAUDE_CONFIG_DIR, join(env.HOME || homedir(), '.claude')].filter((p): p is string => !!p))];
}

/** `<config>/projects/<cwd key>/<sessionId>.jsonl` in any of `configDirs`. */
export function claudeTranscriptExists(configDirs: string[], sessionId: string): boolean {
  if (!ID_RE.test(sessionId)) return false;
  for (const cfg of configDirs) {
    const projects = join(cfg, 'projects');
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(projects, { withFileTypes: true }); } catch { continue; }
    for (const p of entries) {
      if (!p.isDirectory()) continue;
      try { if (fs.existsSync(join(projects, p.name, `${sessionId}.jsonl`))) return true; } catch { /* unreadable: keep looking */ }
    }
  }
  return false;
}

/** A Codex rollout whose file name carries `threadId`, under `<codexHome>/sessions/` (YYYY/MM/DD). */
export function codexRolloutExists(codexHome: string, threadId: string): boolean {
  if (!ID_RE.test(threadId)) return false;
  const walk = (dir: string, depth: number): boolean => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return false; }
    for (const e of entries) {
      if (e.isFile() && e.name.includes(threadId)) return true;
      if (e.isDirectory() && depth < 4 && walk(join(dir, e.name), depth + 1)) return true;
    }
    return false;
  };
  return walk(join(codexHome, 'sessions'), 0);
}

/** The probe a runner uses: the real filesystem. */
export function fsResumeProbe(opts: { workspaceIsolationRoot?: string; env?: Record<string, string | undefined> } = {}): ResumeProbe {
  const dirs = claudeConfigDirs(opts.env);
  return {
    worktreeExists: (p) => { try { return fs.existsSync(p); } catch { return false; } },
    claudeSessionExists: (id, w) => {
      // A worker on a per-worker config dir (workspace isolation) keeps its
      // transcript there, at a path fixed by workspace and worker id.
      const own = opts.workspaceIsolationRoot && w?.workspaceId
        ? [isolatedClaudeConfigDirPath(w.workspaceId, w.id, opts.workspaceIsolationRoot)]
        : [];
      return claudeTranscriptExists([...own, ...dirs], id);
    },
    codexThreadExists: (w, threadId) => {
      const homes = [stableCodexHomePath(w.id)];
      if (opts.workspaceIsolationRoot && w.workspaceId) homes.push(stableCodexHomeIsolatedPath(w.workspaceId, w.id, opts.workspaceIsolationRoot));
      return homes.some(h => codexRolloutExists(h, threadId));
    },
  };
}

/**
 * Can this worker continue in its own session after a restart? It needs its
 * worktree (the session's cwd) and its session on disk. Anything else is a
 * new attempt, and `missing` says what was gone, in words.
 */
export function decideRestore(
  worker: Pick<LocalWorker, 'id' | 'workspaceId' | 'worktreePath' | 'sessionId' | 'codexThreadId' | 'taskBackend'>,
  probe: ResumeProbe,
): RestoreVerdict {
  const missing: string[] = [];
  if (!worker.worktreePath || !probe.worktreeExists(worker.worktreePath)) missing.push('its worktree');
  if (worker.taskBackend === 'codex') {
    if (!worker.codexThreadId) missing.push('its Codex thread id');
    else if (!probe.codexThreadExists(worker, worker.codexThreadId)) missing.push('its Codex thread');
  } else if (!worker.sessionId) {
    missing.push('its session id');
  } else if (!probe.claudeSessionExists(worker.sessionId, worker)) {
    missing.push('its session file');
  }
  return missing.length === 0 ? { kind: 'continue' } : { kind: 'new_attempt', missing };
}

/** "a and b" / "a, b and c". */
function andList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/**
 * The error a restart reports for a worker it cannot continue. Starts with
 * "Process restarted" so every reader that already knows that failure keeps
 * reading it the same way; the rest names what was missing (R-38).
 */
export function restartNewAttemptError(missing: string[]): string {
  const gone = andList(missing);
  return `Process restarted: ${gone} ${missing.length === 1 ? 'is' : 'are'} gone, so it could not continue in its own session; the task starts again as a new attempt from its last pushed commit`;
}

/** The first turn a continued session reads. */
export const RESTART_CONTINUE_MESSAGE =
  'The buildd runner stopped and started again, which paused you. Carry on with your task from where you stopped. ' +
  'If a command was running when it stopped, it was interrupted: check its effect before relying on it. ' +
  'If your last commit is a "wip: checkpoint" the runner made, it holds your uncommitted edits from before the stop; keep or reshape it as you see fit.';

/** The first turn a session paused for an update reads (spec 47c97f48, R-5). */
export const UPDATE_CONTINUE_MESSAGE =
  'The buildd runner paused you to apply an update and has started again on the new version. Carry on with your task from where you stopped. ' +
  'If a command was running when it paused you, it was interrupted: check its effect before relying on it. ' +
  'If your last commit is a "wip: checkpoint" the runner made (and pushed), it holds your uncommitted edits from before the update; keep or reshape it as you see fit.';

/**
 * How long after continuing the agents paused for an update the runner waits
 * to see whether any of them runs on the new version, before it hands off to
 * the post-update canary (R-8).
 */
export const UPDATE_CONTINUE_PROBE_MS = 60_000;

// ── the checkpoint ──────────────────────────────────────────────────────────

export interface ShutdownCheckpoint {
  committed: boolean;
  sha?: string;
  /** Why nothing was committed, when the worktree had changes. */
  reason?: string;
}

const CHECKPOINT_IDENTITY = ['-c', 'user.name=buildd-runner', '-c', 'user.email=runner@buildd.invalid', '-c', 'commit.gpgsign=false'];

/**
 * Commit everything the worktree holds (gitignore respected) to the worker's
 * own branch, locally, and only when that branch is what is checked out. No push and no hooks: a save, not a ship. Bounded by
 * `budgetMs` in total; a git that does not answer in time is killed and the
 * changes simply stay uncommitted in the worktree, which is kept.
 */
export async function commitShutdownCheckpoint(
  worktreePath: string,
  workerId: string,
  /** The worker record's own branch. Anything else checked out (or a detached HEAD) is refused. */
  ownBranch: string | undefined,
  budgetMs: number = SHUTDOWN_CHECKPOINT_MS,
): Promise<ShutdownCheckpoint> {
  const deadline = Date.now() + budgetMs;
  const left = () => Math.max(250, deadline - Date.now());
  const git = (args: string[]) => gitArgsAsync(args, { cwd: worktreePath, timeoutMs: left(), env: process.env });
  try {
    if (!ownBranch) return { committed: false, reason: 'the worker has no branch of its own on record' };
    let head: string;
    try { head = (await git(['symbolic-ref', '-q', '--short', 'HEAD'])).trim(); } catch { head = ''; }
    if (!head) return { committed: false, reason: 'HEAD is detached' };
    if (head !== ownBranch) return { committed: false, reason: `HEAD is on ${head}, not this worker's branch ${ownBranch}` };
    const dirty = (await git(['status', '--porcelain=v1', '-z', '--untracked-files=all'])).length > 0;
    if (!dirty) return { committed: false };
    await git(['add', '-A']);
    await git([
      ...CHECKPOINT_IDENTITY,
      'commit', '--no-verify', '-q', '-m',
      `wip: checkpoint, the runner stopped before this agent reached a safe point (worker ${workerId.slice(0, 8)})\n\n` +
      'Saved by the buildd runner on a service stop or restart. The agent continues from here in its own session.',
    ]);
    const sha = (await git(['rev-parse', 'HEAD'])).trim();
    return { committed: true, sha };
  } catch (err) {
    return { committed: false, reason: err instanceof Error ? err.message.split('\n')[0] : String(err) };
  }
}

/** An update's checkpoint push, per agent: the push can wait on the network, the stop grace cannot. */
export const UPDATE_PUSH_MS = 30_000;

export interface UpdateCheckpoint extends ShutdownCheckpoint {
  pushed: boolean;
}

/**
 * Before an update restarts the runner (spec 47c97f48, R-4): commit a paused
 * agent's uncommitted edits to its own branch, as a stop does, then push that
 * branch so the work is safe off this machine. Never forced: a remote that
 * moved on refuses it, and the reason says so. Bounded by `budgetMs`.
 */
export async function pushUpdateCheckpoint(
  worktreePath: string,
  workerId: string,
  ownBranch: string | undefined,
  budgetMs: number = UPDATE_PUSH_MS,
): Promise<UpdateCheckpoint> {
  const deadline = Date.now() + budgetMs;
  const cp = await commitShutdownCheckpoint(worktreePath, workerId, ownBranch, Math.min(SHUTDOWN_CHECKPOINT_MS, budgetMs));
  if (cp.reason || !ownBranch) return { ...cp, pushed: false, reason: cp.reason ?? 'the worker has no branch of its own on record' };
  try {
    await gitArgsAsync(['push', '--no-verify', '-q', 'origin', `HEAD:refs/heads/${ownBranch}`], {
      cwd: worktreePath, timeoutMs: Math.max(1_000, deadline - Date.now()), env: process.env,
    });
    return { ...cp, pushed: true };
  } catch (err) {
    return { ...cp, pushed: false, reason: `push failed: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}` };
  }
}

// ── the launcher ────────────────────────────────────────────────────────────

/**
 * Whether something restarts this process when it exits 75 after an update.
 * The launchers buildd ships (install.sh's `buildd`, install.ps1's
 * `buildd.cmd`) say so with BUILDD_LAUNCHER; a host launcher of its own (the
 * Coder template's, which restarts on any exit) can set it too. A bare
 * `bun run src/index.ts` has none: its update restart ends the process and
 * nothing starts it again, which the server reports as an update stuck on it.
 */
export function restartLauncherKnown(env: Record<string, string | undefined> = process.env): boolean {
  return !!env.BUILDD_LAUNCHER?.trim();
}

export const NO_LAUNCHER_WARNING =
  'No launcher is known to restart this runner (BUILDD_LAUNCHER is not set; started as a bare `bun run`?). ' +
  'After the update restart nothing may start it again: run it through `buildd`, `buildd service install`, ' +
  'or your own restart loop with BUILDD_LAUNCHER set. Its paused agents continue on the next start.';

// ── the signal ──────────────────────────────────────────────────────────────

export interface ShutdownSignalDeps {
  /** Pause the agents; resolves when done (or it gave up). */
  pause: (signal: NodeJS.Signals) => Promise<void>;
  exit: (code: number) => void;
  log?: (line: string) => void;
  deadlineMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  on?: (signal: NodeJS.Signals, fn: () => void) => void;
}

/** The exit code for a stop: 0 for the service manager's SIGTERM, 130 for Ctrl-C. */
export function shutdownExitCode(signal: NodeJS.Signals): number {
  return signal === 'SIGINT' ? 130 : 0;
}

/**
 * SIGTERM and SIGINT pause the agents, then exit. Bounded: the process exits
 * by `deadlineMs` whatever is still pending. A second signal exits at once.
 * Returns the handler, for tests.
 */
export function installShutdownSignals(deps: ShutdownSignalDeps): (signal: NodeJS.Signals) => void {
  const log = deps.log ?? ((l: string) => console.log(l));
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const deadlineMs = deps.deadlineMs ?? SHUTDOWN_DEADLINE_MS;
  let stopping: NodeJS.Signals | null = null;
  const handle = (signal: NodeJS.Signals) => {
    if (stopping) {
      log(`[shutdown] ${signal} again: exiting now`);
      deps.exit(shutdownExitCode(signal));
      return;
    }
    stopping = signal;
    log(`[shutdown] ${signal}: pausing running agents (at most ${Math.round(deadlineMs / 1000)}s), then exiting`);
    setTimer(() => {
      log(`[shutdown] pausing did not finish in ${Math.round(deadlineMs / 1000)}s: exiting anyway (the next start restores what is on disk)`);
      deps.exit(shutdownExitCode(signal));
    }, deadlineMs);
    deps.pause(signal)
      .catch((err) => log(`[shutdown] pausing failed: ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => deps.exit(shutdownExitCode(signal)));
  };
  const on = deps.on ?? ((s: NodeJS.Signals, fn: () => void) => { process.on(s, fn); });
  on('SIGTERM', () => handle('SIGTERM'));
  on('SIGINT', () => handle('SIGINT'));
  return handle;
}

export interface RunnerShutdownDeps {
  /** WorkerManager.pauseAllForShutdown, or nothing when no manager runs. */
  pauseAgents: () => Promise<unknown>;
  exit: (code: number) => void;
  log?: (line: string) => void;
  deadlineMs?: number;
  on?: ShutdownSignalDeps['on'];
  setTimer?: ShutdownSignalDeps['setTimer'];
}

/**
 * The runner's one stop handler: the only SIGTERM/SIGINT listener in the
 * long-running process. Pauses the agents, then exits, all inside the one
 * deadline.
 */
export function installRunnerShutdown(deps: RunnerShutdownDeps): (signal: NodeJS.Signals) => void {
  return installShutdownSignals({
    pause: async () => { await deps.pauseAgents(); },
    exit: deps.exit,
    log: deps.log,
    deadlineMs: deps.deadlineMs,
    on: deps.on,
    setTimer: deps.setTimer,
  });
}
