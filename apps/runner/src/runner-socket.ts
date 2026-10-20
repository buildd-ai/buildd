/**
 * One runner per machine, found through a local socket (Living Spec
 * "Runner on your terminal", R-11..R-13).
 *
 * Every long-running runner serves an owner-only unix socket at
 * `<BUILDD_HOME>/runner.sock`, headless included. It answers the same handler
 * the `--debug` HTTP server uses, so `buildd top` reads workers, tasks, config
 * and the `/api/events` stream from it with no port and no local token: who
 * may connect is the boundary. On POSIX that is mode 0600; on Windows, where
 * chmod does nothing, it is an owner-only ACL (restrictSocketToOwner).
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
import { spawnSync } from 'child_process';
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
  | { action: 'attach'; message: string }
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

/** The line `buildd` shows when it opens `top` on the runner already running. */
export function attachingMessage(pid: number | null): string {
  const who = pid ? ` (pid ${pid})` : '';
  return `The background runner is already running${who}. This is buildd top, watching it; q leaves it running.`;
}

/**
 * R-12/R-13. A runner answering on the socket means this start starts nothing.
 * In a terminal that is a hand-off, not a failure: it attaches `buildd top` to
 * the running runner. Without a terminal (a service manager, a script) it is a
 * refusal and exits non-zero. `--foreground` asks for a second runner
 * explicitly, so it is always a refusal.
 */
export function decideStart(input: { probe: SocketProbe; isTTY: boolean; foreground: boolean; socketPath?: string }): StartDecision {
  if (input.probe.state !== 'live') return { action: 'start' };
  // A runner that never answered (no pid) has nothing for top to show: name its socket instead.
  if (input.isTTY && !input.foreground && input.probe.pid !== null) return { action: 'attach', message: attachingMessage(input.probe.pid) };
  return { action: 'exit', code: EXIT_ALREADY_RUNNING, message: alreadyRunningMessage(input.probe.pid, input.socketPath), stream: 'stderr' };
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

/** How long a socket handler may take before the socket answers 504 for it. */
export const SOCKET_HANDLER_DEADLINE_MS = 20_000;

/** A request the socket accepted whose handler has not answered yet. */
export interface InFlightRequest {
  method: string;
  path: string;
  ageMs: number;
}

export interface RunnerSocketServer {
  path: string;
  stop(): void;
  /**
   * Close every connection, drop the listening socket and bind a fresh one at
   * the same path. The watchdog's remedy for a socket that accepts but never
   * answers (createSocketWatchdog).
   */
  rebind(): void;
  /** Requests handed to the handler that have not resolved, oldest first. */
  inFlight(): InFlightRequest[];
  /** Bun's own count of requests it holds open, streams included. */
  pendingRequests(): number;
}

// ── Owner-only, per platform ────────────────────────────────────────────────

const SID_RE = /^S-1-\d+(-\d+)+$/;

/** The SID from `whoami /user /fo csv /nh` ("host\name","S-1-5-21-…"), or null. */
export function parseWhoamiSid(output: string): string | null {
  const fields = output.trim().split(',').map(f => f.trim().replace(/^"|"$/g, ''));
  const sid = fields[fields.length - 1] ?? '';
  return SID_RE.test(sid) ? sid : null;
}

/**
 * System32 by full path: on PATH, `whoami` is often Git for Windows' MSYS one,
 * which has no /user, and a PATH entry must not pick what sets the ACL.
 */
function system32(exe: string): string {
  return join(process.env.SystemRoot || 'C:\\Windows', 'System32', exe);
}

let cachedSid: string | null | undefined;
function currentUserSid(): string | null {
  if (cachedSid === undefined) {
    const r = spawnSync(system32('whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true });
    cachedSid = r.status === 0 ? parseWhoamiSid(r.stdout ?? '') : null;
  }
  return cachedSid;
}

/** Drop the inherited entries and grant the owner alone: the Windows 0600. */
export function ownerOnlyAclCommand(socketPath: string, sid: string): string[] {
  return ['icacls', socketPath, '/inheritance:r', '/grant:r', `*${sid}:(F)`];
}

function runCommand(argv: string[]): { exitCode: number; output: string } {
  const r = spawnSync(argv[0] === 'icacls' ? system32('icacls.exe') : argv[0], argv.slice(1), { encoding: 'utf8', windowsHide: true });
  return { exitCode: r.status ?? -1, output: `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? r.error.message : ''}`.trim() };
}

/**
 * Make the socket connectable by its owner alone.
 *
 * POSIX: chmod 0600 (the 0177 umask at bind already did; a failure here is
 * not fatal). Windows: chmod is a no-op, but AF_UNIX connect there needs
 * write access in the socket file's DACL, so the DACL is the boundary. The
 * socket otherwise inherits its directory's, which under the profile is the
 * owner, SYSTEM and Administrators, but under a BUILDD_HOME or
 * BUILDD_RUNNER_SOCKET elsewhere (C:\ gives BUILTIN\Users Modify on new
 * folders) can be every local account. Windows has no umask, so the
 * directory's ACL applies from bind until this runs. A failure throws: the
 * caller must not serve a socket it could not restrict.
 */
export function restrictSocketToOwner(
  socketPath: string,
  deps: {
    platform?: NodeJS.Platform;
    chmod?: (path: string, mode: number) => void;
    run?: (argv: string[]) => { exitCode: number; output: string };
    sid?: () => string | null;
  } = {},
): void {
  const platform = deps.platform ?? process.platform;
  if (platform !== 'win32') {
    try { (deps.chmod ?? chmodSync)(socketPath, 0o600); } catch { /* umask already applied it */ }
    return;
  }
  const sid = (deps.sid ?? currentUserSid)();
  if (!sid) throw new Error(`cannot restrict ${socketPath} to its owner: no SID for the current user (whoami /user)`);
  const r = (deps.run ?? runCommand)(ownerOnlyAclCommand(socketPath, sid));
  if (r.exitCode !== 0) {
    throw new Error(`cannot restrict ${socketPath} to its owner: icacls exited ${r.exitCode}${r.output ? `: ${r.output}` : ''}`);
  }
}

/**
 * Serve `fetch` on an owner-only unix socket. The socket is created under a
 * 0177 umask so it is never group/world-accessible, even for the moment
 * before the chmod (Windows: see restrictSocketToOwner). On exit the socket is
 * removed, but only if it is still ours (a later runner may already have
 * replaced it). A socket that cannot be made owner-only is closed and removed,
 * and the error is thrown.
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
  opts: {
    error?: (err: Error) => Response | Promise<Response>;
    /**
     * A handler that has not answered in this long gets a 504 instead of
     * holding the connection: a handler awaiting a slow server read must not
     * leave `buildd top`, `hold` and `stop` waiting on it. Default
     * SOCKET_HANDLER_DEADLINE_MS; 0 turns it off.
     */
    deadlineMs?: number;
    /** Requests exempt from the deadline (a long-running POST /api/update). */
    noDeadline?: (req: Request) => boolean;
    /** Makes the bound socket owner-only. Default restrictSocketToOwner; tests replace it. */
    restrict?: (socketPath: string) => void;
  } = {},
): RunnerSocketServer {
  const deadlineMs = opts.deadlineMs ?? SOCKET_HANDLER_DEADLINE_MS;
  // What each accepted request is waiting on, so a socket that stops answering
  // can say whether a handler is stuck or Bun never called one.
  const open = new Map<number, { method: string; path: string; startedAt: number }>();
  let seq = 0;
  const tracked = (req: Request): Response | Promise<Response> => {
    const id = ++seq;
    let path = req.url;
    try { path = new URL(req.url).pathname; } catch { /* keep the raw url */ }
    open.set(id, { method: req.method, path, startedAt: Date.now() });
    let out: Response | Promise<Response>;
    try {
      out = fetch(req);
    } catch (err) {
      open.delete(id);
      throw err;
    }
    if (!(out instanceof Promise)) {
      open.delete(id);
      return out;
    }
    if (deadlineMs > 0 && !opts.noDeadline?.(req)) {
      let timer: ReturnType<typeof setTimeout>;
      const late = new Promise<Response>((resolve) => {
        timer = setTimeout(() => resolve(Response.json(
          { error: `${req.method} ${path} did not finish within ${Math.round(deadlineMs / 1000)}s (a slow server read?)` },
          { status: 504 },
        )), deadlineMs);
      });
      out = Promise.race([out, late]).finally(() => clearTimeout(timer));
    }
    return out.finally(() => open.delete(id));
  };

  let server: ReturnType<typeof Bun.serve>;
  let ino: number | null = null;
  const bind = () => {
    const prevUmask = process.umask(0o177);
    try {
      server = Bun.serve({
        unix: socketPath,
        development: false,
        // `buildd top` holds /api/events open for as long as it runs.
        idleTimeout: 0,
        fetch: tracked,
        ...(opts.error ? { error: opts.error } : {}),
      } as Parameters<typeof Bun.serve>[0]);
    } finally {
      process.umask(prevUmask);
    }
    try {
      (opts.restrict ?? restrictSocketToOwner)(socketPath);
    } catch (err) {
      // Just bound, so the file is ours: never leave it open to others.
      try { server.stop(true); } catch { /* ignore */ }
      try { unlinkSync(socketPath); } catch { /* already gone */ }
      throw err;
    }
    ino = null;
    try { ino = statSync(socketPath).ino; } catch { /* ignore */ }
  };
  bind();

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
    rebind() {
      // Cut every connection the old server holds (a hung request, top's
      // event stream), then take the path again. Only our own file is removed:
      // if something else holds the path now, bind() throws EADDRINUSE.
      try { server.stop(true); } catch { /* a wedged server may not stop cleanly */ }
      open.clear();
      removeIfOurs();
      bind();
    },
    inFlight() {
      const now = Date.now();
      return [...open.values()]
        .sort((a, b) => a.startedAt - b.startedAt)
        .map(r => ({ method: r.method, path: r.path, ageMs: now - r.startedAt }));
    },
    pendingRequests() {
      try { return server.pendingRequests; } catch { return -1; }
    },
  };
}

// ── Event stream readers ────────────────────────────────────────────────────

/**
 * Events queued for one /api/events reader before it is cut off. A reader that
 * stops reading but keeps the connection (a `buildd top` suspended with ^Z, a
 * terminal left behind a sleeping session) otherwise queues every event in the
 * runner's memory for as long as the runner runs. A live top drains each event
 * as it arrives, so it never comes near this; a cut-off one reconnects and gets
 * a fresh init.
 */
export const SSE_MAX_QUEUED_EVENTS = 1_000;

/**
 * Queue one event for a stream reader. False when the reader is gone or so far
 * behind it was closed: the caller drops it from its set.
 */
export function enqueueEvent(controller: ReadableStreamDefaultController, chunk: Uint8Array): boolean {
  try {
    if (controller.desiredSize !== null && controller.desiredSize < -SSE_MAX_QUEUED_EVENTS) {
      try { controller.close(); } catch { /* already closed */ }
      return false;
    }
    controller.enqueue(chunk);
    return true;
  } catch {
    return false;
  }
}

// ── Watchdog ────────────────────────────────────────────────────────────────

export type SocketHealth =
  | { ok: true; status: number; ms: number }
  | { ok: false; reason: 'timeout' | 'absent' | 'refused' | 'error'; detail?: string; ms: number };

/**
 * Ask the socket for /health the way `buildd top` and `buildd hold` would.
 * Any HTTP answer, 503 "starting" included, means it is serving. Never throws.
 */
export async function checkSocketHealth(socketPath: string, timeoutMs: number): Promise<SocketHealth> {
  const started = Date.now();
  try { lstatSync(socketPath); } catch { return { ok: false, reason: 'absent', ms: 0 }; }
  try {
    const res = await fetch('http://localhost/health', {
      unix: socketPath,
      signal: AbortSignal.timeout(timeoutMs),
    } as RequestInit);
    try { await res.arrayBuffer(); } catch { /* the status is the answer */ }
    return { ok: true, status: res.status, ms: Date.now() - started };
  } catch (err) {
    const e = err as { name?: string; code?: string; message?: string } | null;
    const ms = Date.now() - started;
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return { ok: false, reason: 'timeout', ms };
    const text = `${e?.code ?? ''} ${e?.message ?? ''}`;
    if (isRefusal(err)) return { ok: false, reason: 'refused', detail: text.trim(), ms };
    return { ok: false, reason: 'error', detail: text.trim() || String(err), ms };
  }
}

export interface SocketWatchdogState {
  socketPath: string;
  consecutiveFailures: number;
  rebinds: number;
  lastFailure: string | null;
}

export type WatchdogTick = 'skipped' | 'ok' | 'recovered' | 'failed' | 'rebound' | 'rebind-failed' | 'rebound-still-failing';

export const SOCKET_WATCHDOG_INTERVAL_MS = 60_000;
const SOCKET_WATCHDOG_TIMEOUT_MS = 5_000;
const SOCKET_WATCHDOG_FAILURES_BEFORE_REBIND = 2;

function describeOpen(server: RunnerSocketServer): string {
  const open = server.inFlight();
  const shown = open.slice(0, 8).map(r => `${r.method} ${r.path} (${Math.round(r.ageMs / 1000)}s)`).join(', ');
  const more = open.length > 8 ? `, +${open.length - 8} more` : '';
  return `handlers not answered: ${open.length ? shown + more : 'none'}; Bun pending requests: ${server.pendingRequests()}`;
}

/**
 * The runner probes its own socket. A socket that accepts and never answers
 * cuts the owner off from the runner (`buildd top`, `hold`, `stop`) while it
 * goes on claiming work, so a missed probe is logged loudly, naming the
 * requests still open, and after `failuresBeforeRebind` misses in a row the
 * socket is rebound. The caller drives `tick` on a timer.
 */
export function createSocketWatchdog(opts: {
  server: RunnerSocketServer;
  timeoutMs?: number;
  failuresBeforeRebind?: number;
  probe?: (socketPath: string, timeoutMs: number) => Promise<SocketHealth>;
  log: (msg: string) => void;
  warn: (msg: string) => void;
}): { tick(): Promise<WatchdogTick>; state(): SocketWatchdogState } {
  const { server, log, warn } = opts;
  const timeoutMs = opts.timeoutMs ?? SOCKET_WATCHDOG_TIMEOUT_MS;
  const threshold = Math.max(1, opts.failuresBeforeRebind ?? SOCKET_WATCHDOG_FAILURES_BEFORE_REBIND);
  const probe = opts.probe ?? checkSocketHealth;
  const st: SocketWatchdogState = { socketPath: server.path, consecutiveFailures: 0, rebinds: 0, lastFailure: null };
  let busy = false;

  const reasonOf = (h: SocketHealth) => h.ok ? '' : `${h.reason}${h.detail ? ` (${h.detail})` : ''} after ${h.ms}ms`;

  async function tick(): Promise<WatchdogTick> {
    // A probe still waiting on its timeout: let it finish.
    if (busy) return 'skipped';
    busy = true;
    try {
      const health = await probe(server.path, timeoutMs);
      if (health.ok) {
        const wasFailing = st.consecutiveFailures > 0;
        st.consecutiveFailures = 0;
        st.lastFailure = null;
        if (wasFailing) log(`[runner-socket] ${server.path} answers again`);
        return wasFailing ? 'recovered' : 'ok';
      }

      st.consecutiveFailures++;
      st.lastFailure = reasonOf(health);
      warn(`[runner-socket] ${server.path} did not answer /health: ${st.lastFailure} (miss ${st.consecutiveFailures} of ${threshold}). buildd top, hold and stop cannot reach this runner. ${describeOpen(server)}`);
      if (st.consecutiveFailures < threshold) return 'failed';

      try {
        server.rebind();
      } catch (err) {
        warn(`[runner-socket] rebinding ${server.path} failed: ${(err as Error)?.message ?? err}. Restart the runner to get the socket back.`);
        st.consecutiveFailures = 0;
        return 'rebind-failed';
      }
      st.rebinds++;
      st.consecutiveFailures = 0;
      const after = await probe(server.path, timeoutMs);
      if (after.ok) {
        st.lastFailure = null;
        log(`[runner-socket] rebound ${server.path}; it answers again (rebind ${st.rebinds})`);
        return 'rebound';
      }
      st.lastFailure = reasonOf(after);
      warn(`[runner-socket] ${server.path} still does not answer after the rebind: ${st.lastFailure}. Restart the runner to get the socket back.`);
      return 'rebound-still-failing';
    } finally {
      busy = false;
    }
  }

  return { tick, state: () => ({ ...st }) };
}

/**
 * The doctor's `runner-process` line when the runner runs it on itself: the
 * process is plainly running, so what matters is whether its socket answers.
 * Never `fixable`: the watchdog already rebinds, and the doctor has nothing
 * more to try.
 */
export function socketHealthCheck(state: SocketWatchdogState | null): {
  name: 'runner-process'; status: 'ok' | 'warn' | 'error'; message: string; fixable?: boolean;
} {
  if (!state) {
    return { name: 'runner-process', status: 'warn', message: 'Runner running, but it serves no socket: buildd top, hold and stop cannot reach it' };
  }
  if (state.consecutiveFailures > 0 || state.lastFailure) {
    return {
      name: 'runner-process',
      status: 'error',
      message: `Runner running, but ${state.socketPath} does not answer (${state.lastFailure ?? 'no answer'}; ${state.rebinds} rebind(s) so far)`,
    };
  }
  return { name: 'runner-process', status: 'ok', message: `Runner running; ${state.socketPath} answers` };
}

/** `buildd --doctor`'s runner-process line, from a probe of the socket. */
export function runnerProcessFromProbe(probe: SocketProbe, socketPath: string): ReturnType<typeof socketHealthCheck> {
  if (probe.state === 'live' && probe.pid !== null) {
    return { name: 'runner-process', status: 'ok', message: `Runner running (pid ${probe.pid}); ${socketPath} answers` };
  }
  if (probe.state === 'live') {
    return {
      name: 'runner-process',
      status: 'error',
      message: `A process holds ${socketPath} but did not say who it is: a runner whose socket is wedged, or an older one. Find it with: lsof ${socketPath}`,
    };
  }
  return { name: 'runner-process', status: 'error', message: `No runner answers on ${socketPath}` };
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
