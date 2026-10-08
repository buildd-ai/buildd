/**
 * Re-attaching to a runner the agent lost its handle on.
 *
 * The cloud agent (a Durable Object) can restart while its container keeps
 * running. Cloudflare gives it no way to re-open the exec stream of the
 * process it started, so the runner leaves two records in the builddHome and
 * a fresh agent execs `--attach-orphan` to wait on them: `once-<task>.pid`
 * (written at start) and `once-<task>.exit` (the exit code, written just
 * before the process exits). The attach process exits with the recorded code,
 * so the agent treats it exactly like the original exec's exit.
 */
import { join } from 'path';

/** The runner this container was running is gone and left no exit record: nothing to adopt. */
export const EXIT_NOT_ATTACHABLE = 6;

export function runRecordPaths(builddHome: string, taskId: string): { pid: string; exit: string } {
  const safe = taskId.replace(/[^A-Za-z0-9_-]/g, '_');
  return { pid: join(builddHome, `once-${safe}.pid`), exit: join(builddHome, `once-${safe}.exit`) };
}

export interface AttachDeps {
  readPid(): number | null;
  readExit(): number | null;
  isAlive(pid: number): boolean;
  sleep(ms: number): Promise<void>;
  log(msg: string): void;
  pollMs?: number;
  /** After the pid vanishes, how long the exit record may still be on its way. */
  graceMs?: number;
}

export async function runAttachOrphan(opts: { workerId: string }, d: AttachDeps): Promise<number> {
  const pollMs = d.pollMs ?? 2_000;
  const graceMs = d.graceMs ?? 5_000;
  const done = d.readExit();
  if (done !== null) {
    d.log(`[once] runner for worker ${opts.workerId} had already exited ${done}`);
    return done;
  }
  const pid = d.readPid();
  if (pid === null) {
    d.log(`[once] no runner record for worker ${opts.workerId}; cannot attach`);
    return EXIT_NOT_ATTACHABLE;
  }
  d.log(`[once] attached to runner pid ${pid} (worker ${opts.workerId})`);
  while (d.isAlive(pid)) {
    const code = d.readExit();
    if (code !== null) return code;
    await d.sleep(pollMs);
  }
  for (let waited = 0; waited <= graceMs; waited += pollMs) {
    const code = d.readExit();
    if (code !== null) return code;
    await d.sleep(pollMs);
  }
  d.log(`[once] runner pid ${pid} is gone with no exit record`);
  return EXIT_NOT_ATTACHABLE;
}

/** Real wiring: pid/exit files under the builddHome. */
export async function attachDepsFromFs(builddHome: string, taskId: string, log: (m: string) => void): Promise<AttachDeps> {
  const { readFileSync } = await import('fs');
  const paths = runRecordPaths(builddHome, taskId);
  const readInt = (p: string): number | null => {
    try {
      const n = Number.parseInt(readFileSync(p, 'utf8').trim(), 10);
      return Number.isInteger(n) ? n : null;
    } catch { return null; }
  };
  return {
    readPid: () => readInt(paths.pid),
    readExit: () => readInt(paths.exit),
    isAlive: (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; } },
    sleep: (ms) => new Promise(r => setTimeout(r, ms)),
    log,
  };
}

/** The runner's own side: note the pid at start, the code at exit. Never throws. */
export async function recordRunStart(builddHome: string, taskId: string): Promise<void> {
  try {
    const { writeFileSync, rmSync, mkdirSync } = await import('fs');
    const paths = runRecordPaths(builddHome, taskId);
    mkdirSync(builddHome, { recursive: true });
    rmSync(paths.exit, { force: true });
    writeFileSync(paths.pid, String(process.pid));
  } catch { /* the record is best-effort; the run does not depend on it */ }
}

export async function recordRunExit(builddHome: string, taskId: string, code: number): Promise<void> {
  try {
    const { writeFileSync } = await import('fs');
    writeFileSync(runRecordPaths(builddHome, taskId).exit, String(code));
  } catch { /* best-effort */ }
}
