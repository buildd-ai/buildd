/**
 * The POSIX shell the runner runs its shell command lines through, and how it
 * kills a child together with what that child started.
 *
 * Much of the runner builds sh command lines (`git merge-base ... 2>/dev/null`,
 * `command -v mergiraf`, repo manifest steps) and hands them to `/bin/sh -c`.
 * Windows has no `/bin/sh`, and Node's default shell there is cmd.exe, which
 * reads single quotes, `$(...)`, `|| true` and `2>/dev/null` differently. Git
 * for Windows, which a Windows runner needs anyway, ships a POSIX sh next to
 * git: `<install>/usr/bin/sh.exe`. So on win32 the runner uses that sh and the
 * command lines stay byte-identical to the ones the POSIX runners run.
 *
 * `BUILDD_POSIX_SHELL` overrides the choice on any platform.
 */
import * as childProcess from 'child_process';
import * as fs from 'fs';

export class PosixShellMissingError extends Error {
  override name = 'PosixShellMissingError';
}

export interface PosixShellDeps {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  /** `git --exec-path`, trimmed; null when git is missing. */
  gitExecPath: () => string | null;
  exists: (path: string) => boolean;
}

function realGitExecPath(): string | null {
  try {
    const r = childProcess.spawnSync('git', ['--exec-path'], { encoding: 'utf-8', timeout: 5_000, windowsHide: true });
    return r.status === 0 ? r.stdout.trim() || null : null;
  } catch {
    return null;
  }
}

const realDeps = (): PosixShellDeps => ({
  platform: process.platform,
  env: process.env,
  gitExecPath: realGitExecPath,
  exists: (p) => fs.existsSync(p),
});

/**
 * Where Git for Windows keeps sh.exe, given `git --exec-path`
 * (e.g. `C:/Program Files/Git/mingw64/libexec/git-core`).
 */
export function gitForWindowsShCandidates(execPath: string): string[] {
  const root = execPath.replace(/[\\/]+$/, '').replace(/[\\/](mingw64|mingw32|clangarm64|ucrt64)[\\/]libexec[\\/]git-core$/i, '');
  if (root === execPath.replace(/[\\/]+$/, '')) return [];
  return [`${root}/usr/bin/sh.exe`, `${root}/bin/sh.exe`];
}

/** Resolve the shell without caching; see posixShell(). */
export function resolvePosixShell(deps: PosixShellDeps = realDeps()): string {
  const override = deps.env.BUILDD_POSIX_SHELL?.trim();
  if (override) return override;
  if (deps.platform !== 'win32') return '/bin/sh';
  const execPath = deps.gitExecPath();
  for (const candidate of execPath ? gitForWindowsShCandidates(execPath) : []) {
    if (deps.exists(candidate)) return candidate;
  }
  throw new PosixShellMissingError(
    execPath
      ? `no sh.exe found next to git (${execPath}); install Git for Windows, or set BUILDD_POSIX_SHELL to a POSIX sh`
      : 'git is not on PATH; install Git for Windows (it provides the POSIX sh the runner needs), or set BUILDD_POSIX_SHELL',
  );
}

let cached: string | undefined;

/**
 * `/bin/sh` on POSIX; Git for Windows' sh.exe on win32. Resolved once per
 * process. Throws PosixShellMissingError on a Windows host without one, so a
 * caller fails with a next step instead of an ENOENT on `/bin/sh`.
 */
export function posixShell(): string {
  if (cached === undefined) cached = resolvePosixShell();
  return cached;
}

/**
 * win32 stand-in for `command -v <name>`: the executable on PATH (PATHEXT
 * applies), with forward slashes so the path also works unquoted inside the
 * sh command lines git runs (merge drivers), and as an execFile target.
 * `command -v` under Git's sh would answer an MSYS path (`/c/...`) that
 * execFile cannot start.
 */
export function windowsExecutablePath(name: string, which: (n: string) => string | null = (n) => Bun.which(n)): string | null {
  const found = which(name);
  return found ? found.replace(/\\/g, '/') : null;
}

/** Test seam: forget the cached shell. */
export function __resetPosixShellCache(): void {
  cached = undefined;
}

/**
 * Run by Git for Windows' sh: signal the MSYS process group of the process
 * whose Windows pid is $1. That sh keeps POSIX process groups in its own
 * process table (`/proc/<pid>/winpid`, `/proc/<pid>/pgid`), and a child it
 * forks is NOT a child in the Windows process tree, so `taskkill /T` on the
 * sh misses e.g. the git of `git ... || true`, which keeps the pipes open.
 */
export const MSYS_GROUP_KILL_SCRIPT =
  'w=$1; s=$2; for p in /proc/[0-9]*; do [ "$(cat "$p/winpid" 2>/dev/null)" = "$w" ] || continue; kill -s "$s" -- "-$(cat "$p/pgid")" 2>/dev/null; done; :';

export interface KillTreeDeps {
  platform: NodeJS.Platform;
  killGroup: (pid: number, signal: NodeJS.Signals) => void;
  /** win32: end the tree; async and unawaited (the caller waits for the exit). */
  killWindowsTree: (pid: number, signal: NodeJS.Signals) => void;
}

function realKillWindowsTree(pid: number, signal: NodeJS.Signals): void {
  const taskkill = () => {
    const child = childProcess.spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    child.on('error', () => { /* no taskkill: nothing more to try */ });
  };
  let shell: string;
  try { shell = posixShell(); } catch { taskkill(); return; }
  // The MSYS group first, then taskkill for the native processes the sh does
  // not track (git.exe itself). Native Windows processes get no TERM to clean
  // up on, so there is no grace to wait for: both run at once.
  const group = childProcess.spawn(shell, ['-c', MSYS_GROUP_KILL_SCRIPT, 'buildd-kill', String(pid), signal.replace(/^SIG/, '')], { stdio: 'ignore', windowsHide: true });
  group.on('error', taskkill);
  group.on('close', taskkill);
}

const realKillDeps = (): KillTreeDeps => ({
  platform: process.platform,
  killGroup: (pid, signal) => process.kill(-pid, signal),
  killWindowsTree: realKillWindowsTree,
});

/**
 * Signal a child spawned with `detached: true` and everything it started.
 *
 * POSIX: the child leads its own process group, so the signal goes to the
 * group. Windows has no process groups in the OS: the signal goes to the
 * child's MSYS process group (see MSYS_GROUP_KILL_SCRIPT), then
 * `taskkill /T /F` ends its Windows tree. Throws when the POSIX group is
 * gone, like process.kill.
 */
export function killProcessTree(pid: number, signal: NodeJS.Signals, deps: KillTreeDeps = realKillDeps()): void {
  if (deps.platform === 'win32') deps.killWindowsTree(pid, signal);
  else deps.killGroup(pid, signal);
}
