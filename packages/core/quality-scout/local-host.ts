/**
 * The parts of a local Quality Scout host that need nothing but a git
 * checkout and a shell: a bounded process runner, read-only git helpers, and
 * the command port. Shared by the web dogfood script
 * (apps/web/src/lib/quality-scout-local-host.ts re-exports them) and the
 * runner's Scout host (apps/runner/src/scout-host.ts), which wraps each probe
 * command in its own sandbox and scrubbed environment.
 *
 * Nothing here pushes, writes outside the checkout and the evidence dir, or
 * reads a credential.
 */

import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import { join } from 'node:path';
import type { ScoutCommandOutput, ScoutCommandRequest } from './executors';

export const SCOUT_COMMAND_TAIL_CHARS = 4_000;

// ── git ─────────────────────────────────────────────────────────────────────

export interface Exec {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

/** Run a process; never throws. `timeoutMs` kills the whole process group. */
export function exec(cmd: string, args: string[], opts: { cwd: string; timeoutMs?: number; env?: Record<string, string | undefined> }): Promise<Exec> {
  const started = Date.now();
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let child;
    try {
      child = childProcess.spawn(cmd, args, { cwd: opts.cwd, env: (opts.env ?? process.env) as NodeJS.ProcessEnv, detached: true });
    } catch (err) {
      resolve({ code: null, stdout: '', stderr: String(err), timedOut: false, durationMs: 0 });
      return;
    }
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* already gone */ }
        }, opts.timeoutMs)
      : undefined;
    child.stdout?.on('data', (d) => { stdout += d; });
    child.stderr?.on('data', (d) => { stderr += d; });
    child.on('error', (err) => { stderr += String(err); });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: timedOut ? null : code, stdout, stderr, timedOut, durationMs: Date.now() - started });
    });
  });
}

async function git(dir: string, args: string[]): Promise<string> {
  const r = await exec('git', args, { cwd: dir, timeoutMs: 60_000 });
  if (r.code !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr.trim().slice(0, 200)}`);
  return r.stdout;
}

export const gitHead = async (dir: string) => (await git(dir, ['rev-parse', 'HEAD'])).trim();
export const gitStatus = async (dir: string) => git(dir, ['status', '--porcelain', '--untracked-files=all']);

export async function gitChangedPaths(dir: string, base: string, head: string): Promise<string[]> {
  return (await git(dir, ['diff', '--name-only', `${base}...${head}`])).split('\n').filter(Boolean);
}

// ── Command port ────────────────────────────────────────────────────────────

export interface LocalCommandRecord {
  request: ScoutCommandRequest;
  output: ScoutCommandOutput;
  /** `git status` lines the command added: anything here means the probe wrote to the checkout. */
  treeChanges: string[];
}

/**
 * Runs a probe's command in `dir`, which must be a clean checkout of the
 * candidate SHA. Anything else is refused with no exit code (the judge reads
 * that as `inconclusive`), so a probe never reports on a tree it did not test.
 */
export interface LocalCommandPortOptions {
  /** A clean checkout of the candidate SHA. */
  dir: string;
  evidenceDir: string;
  /** The probe command's whole environment. Absent: this process's (the dogfood script's choice, not the runner's). */
  env?: Record<string, string | undefined>;
  /**
   * Turns the probe's argv (`['bash', '-c', command]`) into the argv actually
   * spawned, e.g. under a sandbox. Only the probe command is wrapped; the
   * HEAD and tree checks around it run as this process.
   */
  wrap?: (argv: string[]) => string[];
}

export function localCommandPort(opts: LocalCommandPortOptions) {
  const records: LocalCommandRecord[] = [];
  let n = 0;
  return {
    records,
    port: {
      async run(req: ScoutCommandRequest): Promise<ScoutCommandOutput> {
        const head = await gitHead(opts.dir).catch(() => null);
        const before = await gitStatus(opts.dir).catch(() => null);
        if (head !== req.sha || before === null || before.trim() !== '') {
          const why = head !== req.sha ? `checkout is at ${head?.slice(0, 12) ?? 'unknown'}, not ${req.sha.slice(0, 12)}` : 'checkout has uncommitted changes';
          const output: ScoutCommandOutput = { exitCode: null, timedOut: false, stderrTail: `refused: ${why}` };
          records.push({ request: req, output, treeChanges: [] });
          return output;
        }
        const argv = opts.wrap ? opts.wrap(['bash', '-c', req.command]) : ['bash', '-c', req.command];
        const r = await exec(argv[0], argv.slice(1), { cwd: opts.dir, timeoutMs: req.timeoutMs, env: opts.env });
        fs.mkdirSync(opts.evidenceDir, { recursive: true });
        // Unique per process and call: an evidence log is never overwritten by a later run.
        const file = join(opts.evidenceDir, `command-${req.sha.slice(0, 12)}-${process.pid}-${Date.now()}-${++n}.log`);
        fs.writeFileSync(file, `$ ${req.command}\n# ref ${req.ref} sha ${req.sha}\n# exit ${r.code} timedOut ${r.timedOut} ${r.durationMs}ms\n\n--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}\n`);
        const after = (await gitStatus(opts.dir).catch(() => '')).split('\n').filter(Boolean);
        const output: ScoutCommandOutput = {
          exitCode: r.code,
          timedOut: r.timedOut,
          durationMs: r.durationMs,
          stdoutTail: r.stdout.slice(-SCOUT_COMMAND_TAIL_CHARS),
          stderrTail: r.stderr.slice(-SCOUT_COMMAND_TAIL_CHARS),
          evidenceRef: `file:${file}`,
        };
        records.push({ request: req, output, treeChanges: after });
        return output;
      },
    },
  };
}

