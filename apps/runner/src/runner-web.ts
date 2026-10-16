/**
 * `buildd web` (spec c7410e76 R-15): open the local web UI of the runner
 * already running on this machine, found through its socket (runner-socket.ts).
 *
 * The runner serves that UI only when started with --debug (or PORT). When the
 * one running serves none, this says in one line how to turn it on and stops
 * there: restarting a runner mid-task is the person's call, never this command's.
 */
import { lstatSync } from 'fs';
import type { RunnerIdentity } from './runner-socket';

export type WebProbe =
  | { state: 'absent' }
  | { state: 'stale' }
  | { state: 'live'; httpPort: number | null };

export const WEB_OFF_HINT =
  'The runner is running without its browser view. To turn it on, run buildd service install --debug (this restarts it).';

const NOT_RUNNING =
  'No buildd runner is running on this machine. Start one with buildd, or keep one running in the background with buildd service install.';

/** Ask the runner on `socketPath` which port its web UI is on. Never throws. */
export async function readRunnerHttpPort(socketPath: string, timeoutMs = 2_000): Promise<WebProbe> {
  try {
    if (!lstatSync(socketPath).isSocket()) return { state: 'stale' };
  } catch {
    return { state: 'absent' };
  }
  try {
    // Bun extends RequestInit with `unix` for unix domain sockets.
    const res = await fetch('http://localhost/api/runner', {
      unix: socketPath,
      signal: AbortSignal.timeout(timeoutMs),
    } as RequestInit);
    const body = (await res.json().catch(() => ({}))) as Partial<RunnerIdentity>;
    const port = body.httpPort;
    return { state: 'live', httpPort: typeof port === 'number' && port > 0 ? port : null };
  } catch {
    return { state: 'stale' };
  }
}

export interface WebDecision {
  code: number;
  stdout?: string;
  stderr?: string;
  /** Command that opens the URL in a browser, when this platform has one. */
  open?: string[];
}

export function decideWeb(probe: WebProbe, platform: string): WebDecision {
  if (probe.state !== 'live') return { code: 1, stderr: NOT_RUNNING };
  if (probe.httpPort === null) return { code: 1, stderr: WEB_OFF_HINT };
  const url = `http://localhost:${probe.httpPort}`;
  const opener = platform === 'darwin' ? 'open' : platform === 'linux' ? 'xdg-open' : null;
  return opener
    ? { code: 0, stdout: `Opening ${url}`, open: [opener, url] }
    : { code: 0, stdout: `Open ${url} in your browser.` };
}

export async function runWebCommand(deps: {
  socketPath: string;
  platform?: string;
  spawn?: (cmd: string[]) => void;
  log?: (msg: string) => void;
  error?: (msg: string) => void;
}): Promise<number> {
  const log = deps.log ?? console.log;
  const error = deps.error ?? console.error;
  const spawn = deps.spawn ?? ((cmd: string[]) => { Bun.spawn(cmd, { stdio: ['ignore', 'ignore', 'ignore'] }); });
  const d = decideWeb(await readRunnerHttpPort(deps.socketPath), deps.platform ?? process.platform);
  if (d.stdout) log(d.stdout);
  if (d.stderr) error(d.stderr);
  if (d.open) {
    try {
      spawn(d.open);
    } catch {
      log(`Could not open a browser here. Open ${d.open[1]} yourself.`);
    }
  }
  return d.code;
}
