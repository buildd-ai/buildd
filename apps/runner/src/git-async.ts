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
 * the output and the event loop keeps turning. Each call has a hard timeout
 * that kills the child (SIGKILL, so a git stuck on a lock cannot outlive it),
 * and a stdout cap like `execSync`'s maxBuffer.
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

function run(
  file: string,
  args: string[],
  label: string,
  opts: GitAsyncOptions,
): Promise<string> {
  return new Promise<string>((resolvePromise, reject) => {
    let child: childProcess.ChildProcess;
    try {
      child = childProcess.spawn(file, args, {
        cwd: opts.cwd,
        env: opts.env ?? process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        // Own process group, so a timeout kills git itself and not only the
        // `/bin/sh -c` wrapper (whose git child would keep the pipes open).
        detached: true,
      });
    } catch (err) {
      reject(err);
      return;
    }
    const maxBuffer = opts.maxBuffer ?? DEFAULT_MAX_BUFFER;
    const out: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let outBytes = 0;
    let settled = false;
    let timedOut = false;
    let overflow = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const kill = () => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
      }
    };
    const fail = (why: string) => {
      const stderr = Buffer.concat(errChunks).toString('utf-8');
      return new GitAsyncError(`Command failed: ${label} (${why})\n${stderr}`, { exitCode: null, signal: 'SIGKILL', stderr, timedOut });
    };

    // On timeout, reject at once: never wait for pipes a stuck child may hold.
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
      finish(() => reject(fail(`timed out after ${opts.timeoutMs}ms`)));
    }, opts.timeoutMs);
    // A pending git timer must not hold a shutting-down runner open.
    (timer as { unref?: () => void }).unref?.();

    child.stdout?.on('data', (chunk: Buffer) => {
      outBytes += chunk.length;
      if (outBytes > maxBuffer) {
        overflow = true;
        kill();
        finish(() => reject(fail(`stdout exceeded maxBuffer (${maxBuffer} bytes)`)));
        return;
      }
      out.push(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => { errChunks.push(chunk); });

    child.on('error', (err) => finish(() => reject(err)));
    child.on('close', (code, signal) => finish(() => {
      const stderr = Buffer.concat(errChunks).toString('utf-8');
      if (timedOut || overflow || code !== 0) {
        const msg = `Command failed: ${label}\n${stderr}`;
        reject(new GitAsyncError(msg, { exitCode: code, signal: signal as NodeJS.Signals | null, stderr, timedOut }));
        return;
      }
      resolvePromise(Buffer.concat(out).toString('utf-8'));
    }));
  });
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
