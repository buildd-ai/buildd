/**
 * git off the event loop.
 *
 * The runner's main thread serves the local socket (`buildd top`, the local
 * UI), the heartbeat and the claim loop. A synchronous child process
 * (`execSync`) parks that thread until git exits, so one slow `git diff` on a
 * big worktree, or a repo scan running `git remote get-url origin` across many
 * directories back to back, froze every one of them for seconds at a time.
 *
 * These helpers run the same git commands as an async child: the caller awaits
 * the output and the event loop keeps turning. Each call has a hard timeout:
 * SIGTERM to the child's process group, as execSync sends, then SIGKILL after
 * a short grace, and the call settles only once the child has exited, so the
 * locks git drops on TERM are gone when the caller continues. Plus a stdout
 * cap like `execSync`'s maxBuffer.
 *
 * Errors read like `execSync`'s ("Command failed: <cmd>" then stderr), so code
 * that reports `err.message.split('\n')[0]` reports the same first line.
 */
import * as childProcess from 'child_process';

export interface GitAsyncOptions {
  cwd: string;
  /** Kill the child and reject after this long. */
  timeoutMs: number;
  /** Full environment for the child. Default: the current process.env. */
  env?: NodeJS.ProcessEnv;
  /** Reject (and kill the child) once stdout passes this many bytes. Default 16 MiB. */
  maxBuffer?: number;
}

export class GitAsyncError extends Error {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;
  readonly timedOut: boolean;
  constructor(message: string, fields: { exitCode: number | null; signal: NodeJS.Signals | null; stderr: string; timedOut: boolean }) {
    super(message);
    this.name = 'GitAsyncError';
    this.exitCode = fields.exitCode;
    this.signal = fields.signal;
    this.stderr = fields.stderr;
    this.timedOut = fields.timedOut;
  }
}

const DEFAULT_MAX_BUFFER = 16 * 1024 * 1024;
/** After SIGTERM, how long a timed-out child gets to exit (and drop its locks) before SIGKILL. */
export const KILL_GRACE_MS = 3_000;
/** After SIGKILL, the most we wait for the exit before settling anyway. */
const KILL_WAIT_MS = 1_000;

/** How a child ended, before it is mapped to a resolve or a reject. */
interface RawRun {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  overflow: boolean;
  maxBuffer: number;
  /** The child could not be started, or errored. */
  error?: Error;
}

/**
 * Spawn `file args` in its own process group and settle once it has exited.
 *
 * A timeout (or a stdout past maxBuffer) sends SIGTERM to the group, as
 * execSync does, then waits for the exit: git removes its `index.lock` /
 * `config.lock` on TERM, so the caller's next git finds them gone. A child
 * still there after KILL_GRACE_MS gets SIGKILL, and the call settles after
 * at most KILL_WAIT_MS more even if something still holds the pipes.
 */
function spawnSettled(file: string, args: string[], opts: GitAsyncOptions): Promise<RawRun> {
  return new Promise<RawRun>((resolvePromise) => {
    const maxBuffer = opts.maxBuffer ?? DEFAULT_MAX_BUFFER;
    let child: childProcess.ChildProcess;
    try {
      child = childProcess.spawn(file, args, {
        cwd: opts.cwd,
        env: opts.env ?? process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        // Own process group, so a timeout reaches git itself and not only the
        // `/bin/sh -c` wrapper (whose git child would keep the pipes open).
        detached: true,
      });
    } catch (err) {
      resolvePromise({ status: null, signal: null, stdout: '', stderr: '', timedOut: false, overflow: false, maxBuffer, error: err as Error });
      return;
    }
    const out: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let outBytes = 0;
    let settled = false;
    let timedOut = false;
    let overflow = false;
    let killing = false;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const later = (ms: number, fn: () => void) => {
      const t = setTimeout(fn, ms);
      // A pending git timer must not hold a shutting-down runner open.
      (t as { unref?: () => void }).unref?.();
      timers.push(t);
    };
    const text = (chunks: Buffer[]) => Buffer.concat(chunks).toString('utf-8');
    const settle = (status: number | null, signal: NodeJS.Signals | null, error?: Error) => {
      if (settled) return;
      settled = true;
      for (const t of timers) clearTimeout(t);
      resolvePromise({ status, signal, stdout: text(out), stderr: text(errChunks), timedOut, overflow, maxBuffer, ...(error ? { error } : {}) });
    };
    const signalGroup = (sig: NodeJS.Signals) => {
      try {
        if (child.pid) process.kill(-child.pid, sig);
        else child.kill(sig);
      } catch {
        try { child.kill(sig); } catch { /* already gone */ }
      }
    };
    const stop = () => {
      if (killing) return;
      killing = true;
      signalGroup('SIGTERM');
      later(KILL_GRACE_MS, () => {
        signalGroup('SIGKILL');
        later(KILL_WAIT_MS, () => settle(null, 'SIGKILL'));
      });
    };

    later(opts.timeoutMs, () => { timedOut = true; stop(); });
    child.stdout?.on('data', (chunk: Buffer) => {
      if (killing) return;
      outBytes += chunk.length;
      if (outBytes > maxBuffer) {
        overflow = true;
        stop();
        return;
      }
      out.push(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => { errChunks.push(chunk); });
    child.on('error', (err) => settle(null, null, err));
    child.on('close', (code, signal) => settle(code, signal as NodeJS.Signals | null));
  });
}

async function run(
  file: string,
  args: string[],
  label: string,
  opts: GitAsyncOptions,
): Promise<string> {
  const r = await spawnSettled(file, args, opts);
  if (r.error && !r.timedOut && !r.overflow) throw r.error;
  if (r.timedOut || r.overflow) {
    const why = r.timedOut ? `timed out after ${opts.timeoutMs}ms` : `stdout exceeded maxBuffer (${r.maxBuffer} bytes)`;
    throw new GitAsyncError(`Command failed: ${label} (${why})\n${r.stderr}`, { exitCode: null, signal: r.signal ?? 'SIGTERM', stderr: r.stderr, timedOut: r.timedOut });
  }
  if (r.status !== 0) {
    throw new GitAsyncError(`Command failed: ${label}\n${r.stderr}`, { exitCode: r.status, signal: r.signal, stderr: r.stderr, timedOut: false });
  }
  return r.stdout;
}

/** `git <args...>` without a shell (args are passed verbatim). Resolves stdout, untrimmed. */
export function gitArgsAsync(args: string[], opts: GitAsyncOptions): Promise<string> {
  return run('git', args, `git ${args.join(' ')}`, opts);
}

/**
 * A git command line run through `/bin/sh -c`, exactly as `execSync(cmd)` runs
 * it, for callers that build a shell-quoted string and must keep it
 * byte-identical. Resolves stdout, untrimmed.
 */
export function gitShellAsync(command: string, opts: GitAsyncOptions): Promise<string> {
  return run('/bin/sh', ['-c', command], command, opts);
}

/** How a git child ended, for callers that read stdout and stderr on failure too. */
export interface GitRunResult {
  /** Exit code; null when killed (timeout, maxBuffer) or never started. */
  status: number | null;
  stdout: string;
  stderr: string;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  /** Set when the child could not be started at all. */
  error?: Error;
}

/**
 * `git <args...>` like spawnSync: resolves how it ended, never rejects. Same
 * timeout (SIGTERM, then SIGKILL after a grace) and stdout cap as
 * gitArgsAsync; stdout is kept on failure.
 */
export async function gitRunAsync(args: string[], opts: GitAsyncOptions): Promise<GitRunResult> {
  const r = await spawnSettled('git', args, opts);
  const error = r.error ?? (r.overflow ? new Error(`stdout exceeded maxBuffer (${r.maxBuffer} bytes)`) : undefined);
  return {
    status: r.timedOut || r.overflow ? null : r.status,
    stdout: r.stdout,
    stderr: r.stderr,
    signal: r.signal,
    timedOut: r.timedOut,
    ...(error ? { error } : {}),
  };
}

/**
 * Map over `items` with at most `limit` calls in flight, preserving order.
 * A slow item holds only its own slot.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}
