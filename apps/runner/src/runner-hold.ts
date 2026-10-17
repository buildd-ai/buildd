/**
 * `buildd hold [--for <duration>]` / `buildd resume` (Living Spec "Runner on
 * your terminal", R-32..R-35): stop this runner choosing new work while the
 * agents it runs finish.
 *
 * The hold is a person's, and it is its own state:
 *   - saved in config.json (`hold: { since, until }`), so a restart, an update
 *     restart or a crash restart keeps it (AC-18);
 *   - never the self-update drain's halt (update-drain.ts) and never the
 *     circuit breaker's pause: a drain that ends or a breaker that resets
 *     leaves it in place, and a self-update still applies while held;
 *   - lifted only by `buildd resume`, `h` in `buildd top`, or its own `until`
 *     (a timer here clears it and tells the runner to claim again, AC-19).
 *
 * It stops the runner CHOOSING work: the broad claim poll, background ingest/scout/probe polls and broadcast
 * assignments. A claim a person makes (`c` in top, POST /api/claim on the
 * socket, Start on the dashboard aimed at this runner) still runs (R-34).
 */
import { existsSync, readFileSync } from 'fs';
import { isRunnerHoldActive, parseRunnerHold, type RunnerHold, type WorkerEnvironment } from '@buildd/shared';
import { writeSecretJsonFile } from './secure-file';
import { UnreadableConfigError } from './runner-name';
import type { SocketProbe } from './runner-socket';

// ── durations ───────────────────────────────────────────────────────────────

const UNIT_MS: Record<string, number> = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1_000 };

/** `2h`, `30m`, `90s`, `1d`, `1h30m` in ms; null for anything else (a bare number has no unit, so it is refused). */
export function parseHoldDuration(raw: string): number | null {
  const s = raw.trim().toLowerCase();
  if (!/^(\d+[dhms])+$/.test(s)) return null;
  let ms = 0;
  for (const [, n, unit] of s.matchAll(/(\d+)([dhms])/g)) ms += Number(n) * UNIT_MS[unit];
  return ms > 0 ? ms : null;
}

// ── config.json ─────────────────────────────────────────────────────────────

function readConfigObject(file: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function readHoldFromConfig(configFile: string): RunnerHold | null {
  return parseRunnerHold(readConfigObject(configFile)?.hold);
}

/**
 * Write `hold` into config.json (null removes it), keeping every other field.
 * Throws UnreadableConfigError, writing nothing, when the file exists but is
 * not a JSON object: it holds the API key, and overwriting it would lose that.
 */
export function saveHoldToConfig(configFile: string, hold: RunnerHold | null): void {
  let cfg: Record<string, unknown> = {};
  if (existsSync(configFile)) {
    const existing = readConfigObject(configFile);
    if (!existing) throw new UnreadableConfigError(configFile);
    cfg = existing;
  }
  if (hold === null) delete cfg.hold;
  else cfg.hold = hold;
  writeSecretJsonFile(configFile, cfg);
}

// ── the runner's store ──────────────────────────────────────────────────────

export interface HoldIO {
  read(): RunnerHold | null;
  write(hold: RunnerHold | null): void;
}

type Timer = ReturnType<typeof setTimeout>;
type Logger = Pick<Console, 'log' | 'warn'>;

export interface RunnerHoldStoreOptions {
  configFile?: string;
  /** Overrides configFile (tests whose `fs` is mocked). */
  io?: HoldIO;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => Timer;
  clearTimer?: (t: Timer) => void;
  logger?: Logger;
}

/** setTimeout's ceiling; a longer hold re-arms when it fires. */
const MAX_TIMER_MS = 2_147_483_647;

export class RunnerHoldStore {
  private hold_: RunnerHold | null;
  private timer: Timer | null = null;
  private readonly listeners = new Set<(hold: RunnerHold | null) => void>();
  private readonly io: HoldIO;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => Timer;
  private readonly clearTimer: (t: Timer) => void;
  private readonly logger: Logger;

  constructor(opts: RunnerHoldStoreOptions = {}) {
    const file = opts.configFile;
    this.io = opts.io ?? {
      read: () => (file ? readHoldFromConfig(file) : null),
      write: (h) => { if (file) saveHoldToConfig(file, h); },
    };
    this.now = opts.now ?? Date.now;
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((t) => clearTimeout(t));
    this.logger = opts.logger ?? console;
    let read: RunnerHold | null = null;
    try { read = this.io.read(); } catch { /* unreadable: not held */ }
    this.hold_ = read;
    if (read && !isRunnerHoldActive(read, this.now())) {
      // It lapsed while the runner was down: lift it now rather than obey it.
      this.hold_ = null;
      this.persist(null);
    }
    this.arm();
  }

  /** The hold in force now, or null. A hold past its `until` is lifted here. */
  current(): RunnerHold | null {
    if (this.hold_ && !isRunnerHoldActive(this.hold_, this.now())) this.lift('its time ran out');
    return this.hold_;
  }

  isHeld(): boolean {
    return this.current() !== null;
  }

  /** Hold, for `forMs` or until resumed. Holding again keeps the first `since`. */
  hold(forMs: number | null): RunnerHold {
    const now = this.now();
    const since = this.current()?.since ?? new Date(now).toISOString();
    const hold: RunnerHold = { since, until: forMs && forMs > 0 ? new Date(now + forMs).toISOString() : null };
    this.hold_ = hold;
    this.persist(hold);
    this.arm();
    this.logger.log(`[runner-hold] on hold${hold.until ? ` until ${hold.until}` : ''}: nothing new starts, running work finishes`);
    this.notify();
    return hold;
  }

  /** Lift the hold. Returns the hold that was lifted, or null when there was none. */
  resume(): RunnerHold | null {
    const was = this.current();
    if (!was) return null;
    this.lift('resumed');
    return was;
  }

  onChange(fn: (hold: RunnerHold | null) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  dispose(): void {
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
    this.listeners.clear();
  }

  private lift(why: string): void {
    this.hold_ = null;
    this.persist(null);
    this.arm();
    this.logger.log(`[runner-hold] hold lifted (${why}): claiming again`);
    this.notify();
  }

  private persist(hold: RunnerHold | null): void {
    try {
      this.io.write(hold);
    } catch (err) {
      // Held in memory either way; only a restart would lose it.
      this.logger.warn(`[runner-hold] could not save the hold (${(err as Error)?.message ?? err}); it lasts until this runner restarts`);
    }
  }

  /** One timer, at `until`, so a `--for` hold lifts on time even when nothing else ticks. */
  private arm(): void {
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
    const until = this.hold_?.until ? Date.parse(this.hold_.until) : null;
    if (until === null) return;
    const ms = Math.max(0, until - this.now());
    this.timer = this.setTimer(() => {
      this.timer = null;
      if (this.hold_ && !isRunnerHoldActive(this.hold_, this.now())) this.lift('its time ran out');
      else this.arm();
    }, Math.min(ms, MAX_TIMER_MS));
    (this.timer as { unref?: () => void })?.unref?.();
  }

  private notify(): void {
    for (const fn of this.listeners) {
      try { fn(this.hold_); } catch { /* a listener never breaks the hold */ }
    }
  }
}

let instance: RunnerHoldStore | null = null;

/** Set up the runner's hold (index.ts, once). `null` clears it (tests). */
export function initRunnerHold(opts: RunnerHoldStoreOptions | null): RunnerHoldStore | null {
  instance?.dispose();
  instance = opts ? new RunnerHoldStore(opts) : null;
  return instance;
}

export function getRunnerHold(): RunnerHoldStore | null {
  return instance;
}

/**
 * Claim gate for workers.ts: true while a person holds this runner. False when
 * no store was set up (tests, CLI tools, `--once`).
 */
export function claimsHeldByPerson(now?: number): boolean {
  if (!instance) return false;
  const h = instance.current();
  return !!h && isRunnerHoldActive(h, now ?? Date.now());
}

/** The hold in force, for the heartbeat and the socket; null when none. */
export function currentRunnerHold(): RunnerHold | null {
  return instance?.current() ?? null;
}

/**
 * The environment the heartbeat (and a claim) sends, with `hold` set: the hold
 * while held, an explicit null otherwise, so the server's stored copy clears
 * the moment the hold is lifted.
 */
export function withRunnerHold(environment: WorkerEnvironment | undefined, hold: RunnerHold | null): WorkerEnvironment | undefined {
  if (!environment) return environment;
  return { ...environment, hold };
}

// ── words ───────────────────────────────────────────────────────────────────

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** `11:12` today, `Thu 11:12` another day, in this machine's local time. */
export function holdClock(iso: string, now: number): string {
  const d = new Date(iso);
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return new Date(now).toDateString() === d.toDateString() ? hm : `${DAYS[d.getDay()]} ${hm}`;
}

function agents(n: number, verb: 'finish' | 'running'): string {
  if (n === 0) return 'Nothing is running.';
  if (verb === 'running') return `${n} agent${n === 1 ? '' : 's'} running.`;
  return `${n} agent${n === 1 ? '' : 's'} still running finish${n === 1 ? 'es' : ''}.`;
}

/** What `buildd hold` prints. */
export function holdLine(hold: RunnerHold, running: number, now: number): string {
  const until = hold.until ? ` until ${holdClock(hold.until, now)}` : '';
  return `On hold${until}: nothing new starts. ${agents(running, 'finish')} buildd resume lifts it${hold.until ? ' sooner' : ''}.`;
}

/** What `buildd resume` prints. */
export function resumeLine(wasHeld: boolean, running: number): string {
  return wasHeld
    ? `Resumed: looking for work now. ${agents(running, 'running')}`
    : `This runner was not on hold, so nothing changed. ${agents(running, 'running')}`;
}

// ── the CLI ─────────────────────────────────────────────────────────────────

export type HoldCommand = { kind: 'hold'; forArg: string | null } | { kind: 'resume' };

export interface HoldCommandDeps {
  configFile: string;
  socketPath: string;
  get?: (path: string) => Promise<{ status: number; body: unknown }>;
  now?: () => number;
  probe?: (socketPath: string) => Promise<SocketProbe>;
  post?: (path: string, body: Record<string, unknown>) => Promise<{ status: number; body: unknown }>;
  /** Where "waiting for the runner" goes (default stderr). */
  waitNotice?: (line: string) => void;
  /** How long the runner may take before that line shows (default 2s). */
  waitNoticeAfterMs?: number;
}

/**
 * How long `buildd hold` / `stop` / `resume` wait for the runner on the socket.
 * A runner busy starting or finishing agents can take several seconds to
 * answer; 5s failed a live runner with "Nothing stopped" (task 7d42431c).
 */
export const RUNNER_SOCKET_TIMEOUT_MS = 25_000;

const WAIT_NOTICE = 'Waiting for the runner on this machine to answer (it is busy)...';

/** Run `fn`; if it has not settled after a moment, say once that we are waiting. */
function waitingNotifier(deps: HoldCommandDeps): <T>(fn: () => Promise<T>) => Promise<T> {
  let said = false;
  const notice = deps.waitNotice ?? ((line: string) => { process.stderr.write(`${line}\n`); });
  const afterMs = deps.waitNoticeAfterMs ?? 2_000;
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    const t = said ? null : setTimeout(() => { if (!said) { said = true; notice(WAIT_NOTICE); } }, afterMs);
    try {
      return await fn();
    } finally {
      if (t) clearTimeout(t);
    }
  };
}

export interface HoldCommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function socketPost(socketPath: string, path: string, body: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`http://localhost${path}`, {
    unix: socketPath,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(RUNNER_SOCKET_TIMEOUT_MS),
  } as RequestInit);
  const text = await res.text();
  let parsed: unknown = text;
  try { parsed = JSON.parse(text); } catch { /* keep the text */ }
  return { status: res.status, body: parsed };
}

/**
 * `buildd hold …` / `buildd resume`. With a runner answering on the socket it
 * asks that runner (a service included); with none it writes config.json so
 * the next start begins held (or not), and says so.
 */
export async function runHoldCommand(cmd: HoldCommand, deps: HoldCommandDeps): Promise<HoldCommandResult> {
  const now = deps.now ?? Date.now;
  let forMs: number | null = null;
  if (cmd.kind === 'hold' && cmd.forArg !== null) {
    forMs = parseHoldDuration(cmd.forArg);
    if (forMs === null) {
      return { code: 64, stdout: '', stderr: `--for takes a time like 2h, 30m or 1h30m, not "${cmd.forArg}". Usage: buildd hold [--for <time>]` };
    }
  }

  const saveLocally = (prefix: string): HoldCommandResult => {
    const t = now();
    const hold: RunnerHold | null = cmd.kind === 'hold'
      ? { since: new Date(t).toISOString(), until: forMs ? new Date(t + forMs).toISOString() : null }
      : null;
    try {
      saveHoldToConfig(deps.configFile, hold);
    } catch (err) {
      if (err instanceof UnreadableConfigError) return { code: 1, stdout: '', stderr: err.message };
      throw err;
    }
    const what = hold
      ? `the next start is on hold ${hold.until ? `until ${holdClock(hold.until, t)}` : 'until buildd resume'}`
      : 'the next start takes new work';
    return { code: 0, stdout: `${prefix} Saved: ${what}.`, stderr: '' };
  };

  const probe = await (deps.probe ?? ((p: string) => import('./runner-socket').then(m => m.probeRunnerSocket(p))))(deps.socketPath);
  if (probe.state !== 'live') return saveLocally('No runner is running on this machine.');

  const post = deps.post ?? ((path: string, body: Record<string, unknown>) => socketPost(deps.socketPath, path, body));
  const waiting = waitingNotifier(deps);
  let res: { status: number; body: unknown };
  try {
    res = await waiting(() => cmd.kind === 'hold' ? post('/api/hold', forMs ? { forMs } : {}) : post('/api/resume', {}));
  } catch (err) {
    return { code: 1, stdout: '', stderr: `The runner on this machine did not answer (${(err as Error)?.message ?? err}). Nothing changed.` };
  }
  if (res.status === 404) return saveLocally('The runner running now does not know hold yet (update it); it applies from its next start.');
  const b = (res.body ?? {}) as { hold?: unknown; running?: unknown; wasHeld?: unknown; error?: unknown };
  if (res.status < 200 || res.status >= 300) {
    return { code: 1, stdout: '', stderr: `The runner refused: ${typeof b.error === 'string' ? b.error : `HTTP ${res.status}`}. Nothing changed.` };
  }
  const running = typeof b.running === 'number' ? b.running : 0;
  if (cmd.kind === 'resume') {
    // R-36: resume also continues every paused agent in its own session.
    const continued = await continuePausedAgents(deps, post);
    const head = resumeLine(b.wasHeld !== false, running);
    return { code: continued.failed ? 1 : 0, stdout: [head, ...continued.lines].join('\n'), stderr: '' };
  }
  const hold = parseRunnerHold(b.hold) ?? { since: new Date(now()).toISOString(), until: null };
  return { code: 0, stdout: holdLine(hold, running, now()), stderr: '' };
}

// ── live agents over the socket ─────────────────────────────────────────────

interface LiveAgent { id: string; title: string; status: string; paused: boolean }

async function socketGet(socketPath: string, path: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`http://localhost${path}`, { unix: socketPath, signal: AbortSignal.timeout(RUNNER_SOCKET_TIMEOUT_MS) } as RequestInit);
  const text = await res.text();
  try { return { status: res.status, body: JSON.parse(text) }; } catch { return { status: res.status, body: text }; }
}

function refusal(body: unknown, status: number): string {
  const b = body as { error?: unknown } | null;
  const why = typeof body === 'string' ? body : typeof b?.error === 'string' ? b.error : '';
  return why ? `${why} (HTTP ${status})` : `HTTP ${status}`;
}

/** The runner's agents (what `buildd top` lists), or an error line. */
async function listAgents(deps: HoldCommandDeps): Promise<LiveAgent[] | { error: string }> {
  const get = deps.get ?? ((path: string) => socketGet(deps.socketPath, path));
  try {
    const r = await get('/api/workers?view=top');
    const workers = Array.isArray((r.body as { workers?: unknown })?.workers) ? (r.body as { workers: any[] }).workers : null;
    if (r.status !== 200 || !workers) return { error: `The runner did not list its agents (${refusal(r.body, r.status)}).` };
    return workers
      .filter(w => w && typeof w.id === 'string' && typeof w.status === 'string')
      .map(w => ({
        id: w.id,
        title: typeof w.taskTitle === 'string' && w.taskTitle ? w.taskTitle : w.id,
        status: w.status,
        paused: w.status === 'waiting' && w.waitingFor?.type === 'pause',
      }));
  } catch (err) {
    return { error: `The runner on this machine did not answer (${(err as Error)?.message ?? err}).` };
  }
}

/**
 * Continue every paused agent in its own session: the answer to its pause,
 * the same path as Resume on the dashboard and `a` on a paused row in top.
 */
async function continuePausedAgents(
  deps: HoldCommandDeps,
  post: (path: string, body: Record<string, unknown>) => Promise<{ status: number; body: unknown }>,
): Promise<{ lines: string[]; failed: boolean }> {
  const agents = await listAgents(deps);
  if ('error' in agents) return { lines: [`${agents.error} Paused agents were not continued; resume each with a in buildd top.`], failed: true };
  const lines: string[] = [];
  let failed = false;
  for (const a of agents.filter(x => x.paused)) {
    try {
      const r = await post(`/api/workers/${encodeURIComponent(a.id)}/answer`, { message: 'Resume' });
      if (r.status >= 200 && r.status < 300) lines.push(`Continued "${a.title}" in its own session.`);
      else { failed = true; lines.push(`Could not continue "${a.title}": ${refusal(r.body, r.status)}`); }
    } catch (err) {
      failed = true;
      lines.push(`Could not continue "${a.title}": the runner did not answer (${(err as Error)?.message ?? err})`);
    }
  }
  return { lines, failed };
}

// ── buildd stop (R-36) ──────────────────────────────────────────────────────

export interface StopCommandDeps extends HoldCommandDeps {
  /** Ask a yes/no question; null when there is no terminal to ask in. */
  confirm?: ((question: string) => Promise<boolean>) | null;
}

/** Ask on the terminal; null when stdin is not one. */
export function terminalConfirm(): ((q: string) => Promise<boolean>) | null {
  if (!process.stdin.isTTY) return null;
  return async (q: string) => {
    const { createInterface } = await import('readline');
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer: string = await new Promise(resolve => rl.question(q, resolve));
      return /^y(es)?$/i.test(answer.trim());
    } finally {
      rl.close();
    }
  };
}

const plural = (n: number) => `${n} agent${n === 1 ? '' : 's'}`;

/**
 * `buildd stop [--abort] [--yes]`: leave the runner on hold and
 *  - by default pause every running agent the way `p` in top does: each stops
 *    at its next safe point and keeps its worktree, branch and session, and
 *    `buildd resume` continues it in that session;
 *  - with `--abort`, end every live agent the way `x` does.
 * Asks first, naming the agents, unless `--yes`. One line per agent, then the hold.
 */
export async function runStopCommand(cmd: { yes: boolean; abort?: boolean }, deps: StopCommandDeps): Promise<HoldCommandResult> {
  const abort = cmd.abort === true;
  const probe = await (deps.probe ?? ((p: string) => import('./runner-socket').then(m => m.probeRunnerSocket(p))))(deps.socketPath);
  if (probe.state !== 'live') {
    const saved = await runHoldCommand({ kind: 'hold', forArg: null }, { ...deps, probe: async () => ({ state: 'absent' }) });
    if (saved.code !== 0) return saved;
    return { ...saved, stdout: saved.stdout.replace('No runner is running on this machine.', 'No runner is running on this machine, so no agent is running.') };
  }
  const post = deps.post ?? ((path: string, body: Record<string, unknown>) => socketPost(deps.socketPath, path, body));

  const agents = await waitingNotifier(deps)(() => listAgents(deps));
  if ('error' in agents) return { code: 1, stdout: '', stderr: `${agents.error} Nothing stopped.` };
  // A pause stops a working agent at its next safe point; one already paused or
  // parked on a question has no session running to pause. --abort ends all of them.
  const targets = agents.filter(a => abort ? (a.status === 'working' || a.status === 'stale' || a.status === 'waiting') : (a.status === 'working' || a.status === 'stale'));

  if (targets.length > 0 && !cmd.yes) {
    const confirm = deps.confirm === undefined ? terminalConfirm() : deps.confirm;
    if (!confirm) return { code: 1, stdout: '', stderr: 'buildd stop asks before it stops agents. Run it in a terminal, or add --yes. Nothing stopped.' };
    const names = targets.map(a => a.title).join(', ');
    const question = abort
      ? `End ${plural(targets.length)} (${names}) and hold this runner? Their unpushed work and conversation are lost, and each task starts again from its last pushed commit. [y/N] `
      : `Pause ${plural(targets.length)} (${names}) and hold this runner? Each keeps its worktree, branch and session; buildd resume continues them. [y/N] `;
    if (!(await confirm(question))) return { code: 0, stdout: 'Nothing stopped. The runner is as it was.', stderr: '' };
  }

  // Hold first, so a stopped agent's slot is not refilled while the rest stop.
  let held: { status: number; body: unknown };
  try {
    held = await post('/api/hold', {});
  } catch (err) {
    return { code: 1, stdout: '', stderr: `The runner on this machine did not answer (${(err as Error)?.message ?? err}). Nothing stopped.` };
  }
  if (held.status < 200 || held.status >= 300) {
    return { code: 1, stdout: '', stderr: `The runner refused to hold (${refusal(held.body, held.status)}). Nothing stopped.` };
  }

  const lines: string[] = [];
  let failed = false;
  for (const a of targets) {
    const path = `/api/workers/${encodeURIComponent(a.id)}/${abort ? 'stop' : 'pause'}`;
    const verb = abort ? 'stop' : 'pause';
    try {
      const r = await post(path, {});
      if (r.status >= 200 && r.status < 300) lines.push(abort ? `Stopped "${a.title}".` : `Paused "${a.title}": it stops at its next safe point and keeps its session.`);
      else { failed = true; lines.push(`Could not ${verb} "${a.title}": ${refusal(r.body, r.status)}`); }
    } catch (err) {
      failed = true;
      lines.push(`Could not ${verb} "${a.title}": the runner did not answer (${(err as Error)?.message ?? err})`);
    }
  }
  const tail = abort
    ? 'On hold: nothing new starts until buildd resume.'
    : 'On hold: nothing new starts. buildd resume lifts it and continues the paused agents.';
  if (targets.length === 0) return { code: 0, stdout: `Nothing is running. ${tail}`, stderr: '' };
  return { code: failed ? 1 : 0, stdout: [...lines, tail].join('\n'), stderr: '' };
}
