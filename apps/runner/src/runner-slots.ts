/**
 * How many agents this runner runs at once: its slots (Living Spec "Runner on
 * your terminal", R-43..R-46).
 *
 *   - `buildd slots <n>` / `+` and `-` in `buildd top` set N; `buildd slots`
 *     alone prints N, how many run, and where N comes from.
 *   - N is saved in config.json (`maxConcurrent`), so every kind of restart
 *     keeps it, and the heartbeat reports it (the dashboard's runner list).
 *   - Raising takes effect at once: the runner claims for the new free slots.
 *   - Lowering below the number running lets the extra agents finish. Only an
 *     explicit choice pauses (`--pause`, `p` in top) or ends (`--abort`, after
 *     the same confirmation as `buildd stop --abort`) the most recently
 *     started extras. A paused extra continues when a slot frees, oldest pause
 *     first (SlotPauseQueue).
 */
import { existsSync, readFileSync } from 'fs';
import { writeSecretJsonFile } from './secure-file';
import { UnreadableConfigError } from './runner-name';
import { RUNNER_SOCKET_TIMEOUT_MS, terminalConfirm } from './runner-hold';
import type { SocketProbe } from './runner-socket';

export const MIN_SLOTS = 1;
/** The same bound the heartbeat accepts. */
export const MAX_SLOTS = 50;

export type SlotsSource = 'config' | 'env' | 'default';

/** Where N comes from: config.json wins, then MAX_CONCURRENT, then the default (3). */
export function slotsSource(saved: { maxConcurrent?: unknown }, env: Record<string, string | undefined>): SlotsSource {
  if (typeof saved.maxConcurrent === 'number' && saved.maxConcurrent > 0) return 'config';
  if (env.MAX_CONCURRENT && Number.parseInt(env.MAX_CONCURRENT, 10) > 0) return 'env';
  return 'default';
}

const SOURCE_WORDS: Record<SlotsSource, string> = {
  config: 'set in ~/.buildd/config.json',
  env: 'from MAX_CONCURRENT',
  default: 'the default',
};

/** A whole number of slots in range, or null. */
export function parseSlots(raw: unknown): number | null {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : NaN;
  return Number.isInteger(n) && n >= MIN_SLOTS && n <= MAX_SLOTS ? n : null;
}

const agents = (n: number) => `${n} agent${n === 1 ? '' : 's'}`;

/** `buildd slots` alone: "6 slots (set in ~/.buildd/config.json): 2 running, 4 free." */
export function slotsStatusLine(slots: number, running: number, source: SlotsSource): string {
  return `${slots} slot${slots === 1 ? '' : 's'} (${SOURCE_WORDS[source]}): ${running} running, ${Math.max(0, slots - running)} free.`;
}

import type { ExtrasMode, SlotsCommand } from './cli-args';
export { classifySlotsArgs, type ExtrasMode, type SlotsCommand } from './cli-args';

/**
 * What a change of N does, in one line (R-44, R-45): raising starts work on
 * the new free slots; lowering below the number running lets the extras
 * finish ("6 running, slots now 4: they finish, nothing new starts until 3 run").
 */
export function slotsChangeLine(slots: number, running: number, mode: ExtrasMode = 'finish', acted = 0): string {
  const extras = running - slots;
  if (extras <= 0) {
    const free = slots - running;
    return `Slots now ${slots}: ${running} running, ${free} free${free > 0 ? ', looking for work for them now' : ''}.`;
  }
  if (mode === 'pause' && acted > 0) {
    return `Slots now ${slots}: paused the ${acted === 1 ? 'newest agent' : `${acted} newest agents`}; each continues in its own session when a slot frees.`;
  }
  if (mode === 'abort' && acted > 0) {
    return `Slots now ${slots}: ended the ${acted === 1 ? 'newest agent' : `${acted} newest agents`}.`;
  }
  const until = slots - 1 === 0 ? 'none run' : `${slots - 1} run`;
  return `${running} running, slots now ${slots}: they finish, nothing new starts until ${until}.`;
}

/** A live agent as the socket lists it. */
export interface SlotAgent { id: string; title: string; status: string; startedAt: number }

/** The agents a lower N makes extra: the most recently started working ones (R-45, R-46). */
export function pickExtras(agents: SlotAgent[], slots: number): SlotAgent[] {
  const working = agents.filter(a => a.status === 'working' || a.status === 'stale');
  const extra = working.length - slots;
  if (extra <= 0) return [];
  return [...working].sort((a, b) => b.startedAt - a.startedAt).slice(0, extra);
}

/**
 * Agents paused to free a slot (`--pause`, `p` in top). When a slot frees, the
 * oldest pause continues first, before any new work is claimed (R-45, AC-29).
 */
export class SlotPauseQueue {
  private entries: Array<{ workerId: string; at: number }> = [];

  add(workerId: string, at: number = Date.now()): void {
    if (this.entries.some(e => e.workerId === workerId)) return;
    this.entries.push({ workerId, at });
    this.entries.sort((a, b) => a.at - b.at);
  }

  remove(workerId: string): void {
    this.entries = this.entries.filter(e => e.workerId !== workerId);
  }

  /** Oldest pause first. */
  list(): string[] {
    return this.entries.map(e => e.workerId);
  }

  get size(): number {
    return this.entries.length;
  }
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

/** Write `maxConcurrent` into config.json, keeping every other field (refuses an unreadable file, which holds the API key). */
export function saveSlotsToConfig(configFile: string, slots: number): void {
  let cfg: Record<string, unknown> = {};
  if (existsSync(configFile)) {
    const existing = readConfigObject(configFile);
    if (!existing) throw new UnreadableConfigError(configFile);
    cfg = existing;
  }
  cfg.maxConcurrent = slots;
  writeSecretJsonFile(configFile, cfg);
}

export function readSlotsFromConfig(configFile: string): number | null {
  return parseSlots(readConfigObject(configFile)?.maxConcurrent);
}

// ── the CLI ─────────────────────────────────────────────────────────────────

export interface SlotsCommandDeps {
  configFile: string;
  socketPath: string;
  env?: Record<string, string | undefined>;
  probe?: (socketPath: string) => Promise<SocketProbe>;
  get?: (path: string) => Promise<{ status: number; body: unknown }>;
  post?: (path: string, body: Record<string, unknown>) => Promise<{ status: number; body: unknown }>;
  /** Ask a yes/no question; null when there is no terminal to ask in. */
  confirm?: ((question: string) => Promise<boolean>) | null;
}

export interface SlotsCommandResult { code: number; stdout: string; stderr: string }

export const SLOTS_USAGE = 'Usage: buildd slots [<n>] [--pause | --abort] [--yes]';

async function socketCall(socketPath: string, path: string, body?: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`http://localhost${path}`, {
    unix: socketPath,
    ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(RUNNER_SOCKET_TIMEOUT_MS),
  } as RequestInit);
  const text = await res.text();
  try { return { status: res.status, body: JSON.parse(text) }; } catch { return { status: res.status, body: text }; }
}

function refusal(body: unknown, status: number): string {
  const b = body as { error?: unknown } | null;
  const why = typeof body === 'string' ? body : typeof b?.error === 'string' ? b.error : '';
  return why ? `${why} (HTTP ${status})` : `HTTP ${status}`;
}

function agentsFrom(body: unknown): SlotAgent[] | null {
  const list = (body as { workers?: unknown })?.workers;
  if (!Array.isArray(list)) return null;
  return list
    .filter((w: any) => w && typeof w.id === 'string' && typeof w.status === 'string')
    .map((w: any) => ({ id: w.id, title: typeof w.taskTitle === 'string' && w.taskTitle ? w.taskTitle : w.id, status: w.status, startedAt: typeof w.startedAt === 'number' ? w.startedAt : 0 }));
}

/**
 * `buildd slots [<n>] [--pause|--abort] [--yes]`. With a runner on the socket
 * it asks that runner (a service included); with none it writes config.json
 * so the next start uses N.
 */
export async function runSlotsCommand(cmd: SlotsCommand, deps: SlotsCommandDeps): Promise<SlotsCommandResult> {
  const env = deps.env ?? process.env;
  let slots: number | null = null;
  if (cmd.kind === 'set') {
    slots = parseSlots(cmd.raw);
    if (slots === null) return { code: 64, stdout: '', stderr: `Slots is a whole number from ${MIN_SLOTS} to ${MAX_SLOTS}, not "${cmd.raw}". ${SLOTS_USAGE}` };
  }
  const probe = await (deps.probe ?? ((p: string) => import('./runner-socket').then(m => m.probeRunnerSocket(p))))(deps.socketPath);
  const get = deps.get ?? ((path: string) => socketCall(deps.socketPath, path));
  const post = deps.post ?? ((path: string, body: Record<string, unknown>) => socketCall(deps.socketPath, path, body));

  if (probe.state !== 'live') {
    if (cmd.kind === 'show') {
      const saved = readSlotsFromConfig(deps.configFile);
      const source = slotsSource({ maxConcurrent: saved ?? undefined }, env);
      const n = saved ?? (source === 'env' ? Number.parseInt(env.MAX_CONCURRENT!, 10) : 3);
      return { code: 0, stdout: `No runner is running on this machine. The next start runs ${n} at once (${SOURCE_WORDS[source]}).`, stderr: '' };
    }
    try {
      saveSlotsToConfig(deps.configFile, slots!);
    } catch (err) {
      if (err instanceof UnreadableConfigError) return { code: 1, stdout: '', stderr: err.message };
      throw err;
    }
    return { code: 0, stdout: `No runner is running on this machine. Saved: the next start runs ${slots} at once.`, stderr: '' };
  }

  if (cmd.kind === 'show') {
    try {
      const r = await get('/api/slots');
      if (r.status === 404) return { code: 1, stdout: '', stderr: 'The runner running now does not know slots yet (update it).' };
      const b = r.body as { slots?: unknown; running?: unknown; source?: unknown };
      if (r.status !== 200 || typeof b?.slots !== 'number') return { code: 1, stdout: '', stderr: `The runner did not say its slots (${refusal(r.body, r.status)}).` };
      const source: SlotsSource = b.source === 'env' || b.source === 'default' ? b.source : 'config';
      return { code: 0, stdout: slotsStatusLine(b.slots, typeof b.running === 'number' ? b.running : 0, source), stderr: '' };
    } catch (err) {
      return { code: 1, stdout: '', stderr: `The runner on this machine did not answer (${(err as Error)?.message ?? err}).` };
    }
  }

  // --abort ends agents: the same confirmation as `buildd stop --abort` (R-46).
  if (cmd.mode === 'abort' && !cmd.yes) {
    let listed: { status: number; body: unknown };
    try {
      listed = await get('/api/workers?view=top');
    } catch (err) {
      return { code: 1, stdout: '', stderr: `The runner on this machine did not answer (${(err as Error)?.message ?? err}). Nothing changed.` };
    }
    const all = agentsFrom(listed.body);
    if (!all) return { code: 1, stdout: '', stderr: `The runner did not list its agents (${refusal(listed.body, listed.status)}). Nothing changed.` };
    const targets = pickExtras(all, slots!);
    if (targets.length > 0) {
      const confirm = deps.confirm === undefined ? terminalConfirm() : deps.confirm;
      if (!confirm) return { code: 1, stdout: '', stderr: 'buildd slots --abort asks before it ends agents. Run it in a terminal, or add --yes. Nothing changed.' };
      const names = targets.map(a => a.title).join(', ');
      const question = `End ${agents(targets.length)} (${names}) and set slots to ${slots}? Their unpushed work and conversation are lost, and each task starts again from its last pushed commit. [y/N] `;
      if (!(await confirm(question))) return { code: 0, stdout: 'Nothing changed. The runner is as it was.', stderr: '' };
    }
  }

  let res: { status: number; body: unknown };
  try {
    res = await post('/api/slots', { slots: slots!, extras: cmd.mode });
  } catch (err) {
    return { code: 1, stdout: '', stderr: `The runner on this machine did not answer (${(err as Error)?.message ?? err}). Nothing changed.` };
  }
  if (res.status === 404) return { code: 1, stdout: '', stderr: 'The runner running now does not know slots yet (update it). Nothing changed.' };
  if (res.status < 200 || res.status >= 300) return { code: 1, stdout: '', stderr: `The runner refused: ${refusal(res.body, res.status)}. Nothing changed.` };
  const b = res.body as { line?: unknown; failed?: unknown };
  const line = typeof b?.line === 'string' ? b.line : `Slots now ${slots}.`;
  const failed = Array.isArray(b?.failed) ? (b.failed as unknown[]).filter((x): x is string => typeof x === 'string') : [];
  return { code: failed.length > 0 ? 1 : 0, stdout: [line, ...failed].join('\n'), stderr: '' };
}

// ── the runner's side (/api/slots on the socket) ────────────────────────────

export interface ApplySlotsDeps {
  /** Save N (config.json) and set it on the running runner; claims for new free slots. */
  setSlots: (slots: number) => void;
  /** The runner's agents, as the socket lists them. */
  agents: () => SlotAgent[];
  /** Pause or end one agent the way `p` / `x` do; true when the server accepted it. */
  act: (workerId: string, action: 'pause' | 'stop') => Promise<{ ok: boolean; why?: string }>;
  /** A paused extra continues when a slot frees, oldest pause first. */
  pauses: SlotPauseQueue;
  now?: () => number;
}

/**
 * POST /api/slots { slots, extras }: set N, and act on the extras only when
 * asked to (R-45, R-46). Lowering never pauses or ends an agent by itself.
 */
export async function applySlots(body: unknown, deps: ApplySlotsDeps): Promise<{ status: number; body: Record<string, unknown> }> {
  const b = (body ?? {}) as { slots?: unknown; extras?: unknown };
  const slots = parseSlots(b.slots);
  if (slots === null) return { status: 400, body: { error: `slots must be a whole number from ${MIN_SLOTS} to ${MAX_SLOTS}` } };
  const mode: ExtrasMode = b.extras === 'pause' || b.extras === 'abort' ? b.extras : 'finish';
  const before = deps.agents();
  const running = before.filter(a => a.status === 'working' || a.status === 'stale').length;
  deps.setSlots(slots);
  const failed: string[] = [];
  let acted = 0;
  if (mode !== 'finish') {
    for (const a of pickExtras(before, slots)) {
      const r = await deps.act(a.id, mode === 'pause' ? 'pause' : 'stop').catch((err: unknown) => ({ ok: false, why: (err as Error)?.message ?? String(err) }));
      if (r.ok) {
        acted++;
        if (mode === 'pause') deps.pauses.add(a.id, (deps.now ?? Date.now)());
      } else {
        failed.push(`Could not ${mode === 'pause' ? 'pause' : 'end'} "${a.title}": ${r.why ?? 'refused'}`);
      }
    }
  }
  return { status: 200, body: { slots, running, extras: Math.max(0, running - slots), acted, line: slotsChangeLine(slots, running, mode, acted), failed } };
}

/**
 * Which slot-paused agents continue now, given `free` slots: oldest pause
 * first, skipping any that is no longer paused (answered, ended). The ones
 * skipped are dropped from the queue.
 */
export function slotResumes(pauses: SlotPauseQueue, isPaused: (workerId: string) => boolean, free: number): string[] {
  const out: string[] = [];
  for (const id of pauses.list()) {
    if (!isPaused(id)) { pauses.remove(id); continue; }
    if (out.length >= free) break;
    out.push(id);
  }
  return out;
}
