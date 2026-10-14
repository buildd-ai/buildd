/**
 * One runner per machine, found through a local socket (Living Spec
 * "Runner on your terminal", R-11..R-13).
 *
 * Every long-running runner serves an owner-only (0600) unix socket at
 * `<BUILDD_HOME>/runner.sock`, headless included. It answers the same handler
 * the `--debug` HTTP server uses, so `buildd top` reads workers, tasks, config
 * and the `/api/events` stream from it with no port and no local token: the
 * file mode is the boundary, the same way it is for the credential broker's
 * socket.
 *
 * The socket is also how a second start finds the first. Before the runner does
 * anything with side effects it probes the socket:
 *
 *   - nothing there            -> start
 *   - a runner answers         -> start nothing; say so (decideStart)
 *   - the file is there but no process accepts the connection -> stale: the
 *     previous runner died without cleaning up. Remove it and start.
 *
 * A connection that is accepted but never answered (a wedged runner) counts as
 * a live runner, not a stale one: the kernel only accepts on a socket some
 * process still holds open, and removing it would let a second runner start
 * beside the first.
 */
import { chmodSync, lstatSync, statSync, unlinkSync } from 'fs';
import { join } from 'path';

export const RUNNER_SOCKET_NAME = 'runner.sock';

/** Path the runner listens on, and a second start probes. */
export function runnerSocketPath(builddHome: string, env: Record<string, string | undefined> = process.env): string {
  return env.BUILDD_RUNNER_SOCKET || join(builddHome, RUNNER_SOCKET_NAME);
}

/**
 * The runner is already running. Never 75: the launcher (install.sh) treats 75
 * as "update applied, restart" and would loop, re-probing forever.
 */
export const EXIT_ALREADY_RUNNING = 69;

export type SocketProbe =
  | { state: 'absent' }
  | { state: 'stale' }
  | { state: 'live'; pid: number | null; version: string | null };

/** What GET /api/runner answers: who holds the socket. */
export interface RunnerIdentity {
  pid: number;
  version: string;
  startedAt: string;
  socket: string;
  /** Port of the --debug web UI, or null when this runner serves none. */
  httpPort: number | null;
}

const PROBE_TIMEOUT_MS = 2_000;

function isRefusal(err: unknown): boolean {
  const e = err as { code?: string; message?: string } | null;
  const text = `${e?.code ?? ''} ${e?.message ?? ''}`;
  return /ECONNREFUSED|ENOENT|ConnectionRefused|FailedToOpenSocket|No such file/i.test(text);
}

/**
 * Ask whatever holds `socketPath` who it is. Never throws.
 */
export async function probeRunnerSocket(
  socketPath: string,
  opts: { timeoutMs?: number } = {},
): Promise<SocketProbe> {
  let isSocket = false;
  try {
    isSocket = lstatSync(socketPath).isSocket();
  } catch {
    return { state: 'absent' };
  }
  if (!isSocket) return { state: 'stale' };

  try {
    // Bun extends RequestInit with `unix` for unix domain sockets.
    const res = await fetch('http://localhost/api/runner', {
      unix: socketPath,
      signal: AbortSignal.timeout(opts.timeoutMs ?? PROBE_TIMEOUT_MS),
    } as RequestInit);
    let pid: number | null = null;
    let version: string | null = null;
    try {
      const body = (await res.json()) as Partial<RunnerIdentity>;
      if (typeof body.pid === 'number') pid = body.pid;
      if (typeof body.version === 'string') version = body.version;
    } catch { /* any answer means a live runner */ }
    return { state: 'live', pid, version };
  } catch (err) {
    if (isRefusal(err)) return { state: 'stale' };
    // Accepted but unanswered (timeout) or a reset mid-answer: a process holds
    // the socket. Treat it as live so we never start a second runner beside it.
    return { state: 'live', pid: null, version: null };
  }
}

export type StartDecision =
  | { action: 'start' }
  | { action: 'exit'; code: number; message: string; stream: 'stdout' | 'stderr' };

/**
 * A pid names the runner best. A runner that accepted the probe but never
 * answered gave no pid, so name the socket it holds instead: that is what the
 * person has to look at (or remove, once they have found the process).
 */
export function alreadyRunningMessage(pid: number | null, socketPath?: string): string {
  const who = pid ? ` (pid ${pid})` : socketPath ? ` (it holds ${socketPath} but did not answer)` : '';
  return `The background runner is already running${who}. Watch it with: buildd top`;
}

/**
 * R-12/R-13. A runner answering on the socket means this start starts nothing.
 * In a terminal that is a hand-off, not a failure: exit 0 (until `buildd top`
 * exists, it names the command). Without a terminal (a service manager, a
 * script) it is a refusal and exits non-zero. `--foreground` asks for a second
 * runner explicitly, so it is always a refusal.
 */
export function decideStart(input: { probe: SocketProbe; isTTY: boolean; foreground: boolean; socketPath?: string }): StartDecision {
  if (input.probe.state !== 'live') return { action: 'start' };
  const message = alreadyRunningMessage(input.probe.pid, input.socketPath);
  if (input.isTTY && !input.foreground) return { action: 'exit', code: 0, message, stream: 'stdout' };
  return { action: 'exit', code: EXIT_ALREADY_RUNNING, message, stream: 'stderr' };
}

/**
 * Probe, clear a stale socket, and decide. Runs before anything else the
 * runner does that has side effects.
 */
export async function checkSingleInstance(input: {
  socketPath: string;
  isTTY: boolean;
  foreground: boolean;
  timeoutMs?: number;
  log?: (msg: string) => void;
}): Promise<{ probe: SocketProbe; decision: StartDecision }> {
  const probe = await probeRunnerSocket(input.socketPath, { timeoutMs: input.timeoutMs });
  if (probe.state === 'stale') {
    try {
      unlinkSync(input.socketPath);
      input.log?.(`[runner-socket] removed stale socket ${input.socketPath} (no runner answered)`);
    } catch { /* gone already */ }
  }
  return { probe, decision: decideStart({ probe, isTTY: input.isTTY, foreground: input.foreground, socketPath: input.socketPath }) };
}

export interface RunnerSocketServer {
  path: string;
  stop(): void;
}

/**
 * Serve `fetch` on an owner-only unix socket. The socket is created under a
 * 0177 umask so it is never group/world-accessible, even for the moment
 * before the chmod. On exit the socket is removed, but only if it is still
 * ours (a later runner may already have replaced it).
 *
 * It never removes an existing file first. checkSingleInstance has already
 * cleared a stale one, so a file still at the path here belongs to a start that
 * raced this one and bound first. Binding then fails (EADDRINUSE) and the
 * caller probes again and exits, instead of unlinking a live runner's socket
 * and running beside it.
 */
export function serveRunnerSocket(
  socketPath: string,
  fetch: (req: Request) => Response | Promise<Response>,
  opts: { error?: (err: Error) => Response | Promise<Response> } = {},
): RunnerSocketServer {
  const prevUmask = process.umask(0o177);
  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({
      unix: socketPath,
      development: false,
      // `buildd top` holds /api/events open for as long as it runs.
      idleTimeout: 0,
      fetch,
      ...(opts.error ? { error: opts.error } : {}),
    } as Parameters<typeof Bun.serve>[0]);
  } finally {
    process.umask(prevUmask);
  }
  try { chmodSync(socketPath, 0o600); } catch { /* umask already applied it */ }

  let ino: number | null = null;
  try { ino = statSync(socketPath).ino; } catch { /* ignore */ }

  const removeIfOurs = () => {
    try {
      if (ino !== null && statSync(socketPath).ino === ino) unlinkSync(socketPath);
    } catch { /* already gone */ }
  };
  process.on('exit', removeIfOurs);

  return {
    path: socketPath,
    stop() {
      process.off('exit', removeIfOurs);
      try { server.stop(true); } catch { /* ignore */ }
      removeIfOurs();
    },
  };
}

// ── Actions for `buildd top` ────────────────────────────────────────────────

/**
 * The socket's worker actions, each relayed to a buildd server route that
 * accepts the runner's API key (the key that claimed the worker), so an answer
 * given in the terminal is recorded and resumed exactly like one given on the
 * dashboard.
 *
 * A message goes to /cmd { action: 'message', text }, not /instruct: /instruct
 * takes a session or admin key and refuses a runner (worker-level) key with
 * 401. /cmd queues and records the message through the same queueInstruction
 * path, always at urgent priority.
 */
export const WORKER_ACTIONS = {
  /** a: answer a waiting question. Body { message }. */
  answer: { endpoint: 'respond', needsMessage: true },
  /** m: message a running agent. Body { message }. Delivered at urgent priority. */
  message: { endpoint: 'cmd', needsMessage: true },
  /** p: pause at the next safe point. */
  pause: { endpoint: 'pause', needsMessage: false },
  /** x: stop the agent. */
  stop: { endpoint: 'cmd', needsMessage: false },
} as const;

export type WorkerAction = keyof typeof WORKER_ACTIONS;

const WORKER_ACTION_PATH = /^\/api\/workers\/([^/]+)\/(answer|message|pause|stop)$/;

export function matchWorkerAction(path: string): { workerId: string; action: WorkerAction } | null {
  const m = path.match(WORKER_ACTION_PATH);
  if (!m) return null;
  return { workerId: decodeURIComponent(m[1]), action: m[2] as WorkerAction };
}

export type ServerSend = (endpoint: string, body: Record<string, unknown>) => Promise<{ status: number; body: unknown }>;

/**
 * Build the server request for one action and send it. A refusal comes back
 * with the server's status and body untouched, so the status line can show the
 * server's own reason.
 */
export async function relayWorkerAction(
  workerId: string,
  action: WorkerAction,
  input: Record<string, unknown>,
  send: ServerSend,
): Promise<{ status: number; body: unknown }> {
  const spec = WORKER_ACTIONS[action];
  const message = typeof input.message === 'string' ? input.message.trim() : '';
  if (spec.needsMessage && !message) {
    return { status: 400, body: { error: 'message required' } };
  }
  const endpoint = `/api/workers/${encodeURIComponent(workerId)}/${spec.endpoint}`;
  let body: Record<string, unknown>;
  switch (action) {
    case 'answer': body = { message }; break;
    case 'message': body = { action: 'message', text: message }; break;
    case 'pause': body = {}; break;
    case 'stop': body = { action: 'abort' }; break;
  }
  return send(endpoint, body);
}
