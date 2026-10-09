// The buildd agent plugin's session-event contract.
//
// A person's interactive coding client (Claude Code, Codex, Cursor) runs the
// plugin's lifecycle hooks; each hook normalizes its client's payload into ONE
// of these events and POSTs it to /api/workers/local-sessions. That is the
// whole wire format: four typed events, no free text. It carries no
// transcript, prompt, response, reasoning or secret, and the server rejects
// any field it does not know. `touch` and `end` may carry `usage`: token counts
// per model and effort counts per claimed worker, read by the hook from the
// session's own local transcript (numbers and model ids only).
//
// Presence is not a worker. A `start` creates a presence row that holds no
// concurrency seat and no task. A `bind` attaches that presence to the worker
// the same session's own verified `claim_task` already minted; it never creates
// one. See docs/specs/local-agent-presence.md.

export const LOCAL_CLIENT_KINDS = ['claude', 'codex', 'cursor', 'other'] as const;
export type LocalClientKind = (typeof LOCAL_CLIENT_KINDS)[number];

export const LOCAL_SESSION_EVENTS = ['start', 'touch', 'bind', 'end'] as const;
export type LocalSessionEventKind = (typeof LOCAL_SESSION_EVENTS)[number];

/**
 * Why a session ended, normalized across clients.
 *  - `exit`: the client process or window closed, or the user logged out.
 *  - `clear`: the conversation was cleared in the same process, which goes on
 *    under a new session id. Its claim is not released: the MCP connection that
 *    made it is still open and still keeps it alive.
 *  - `other`: anything else the client reports (Codex always reports this).
 */
export const LOCAL_SESSION_END_REASONS = ['exit', 'clear', 'other'] as const;
export type LocalSessionEndReason = (typeof LOCAL_SESSION_END_REASONS)[number];

export interface LocalSessionEvent {
  event: LocalSessionEventKind;
  client: LocalClientKind;
  /** The client's own session/conversation id. Hashed server-side, never stored raw. */
  clientSessionId: string;
  clientVersion?: string;
  /** owner/name of the cwd's git remote. Never a URL with credentials. */
  repo?: string;
  /** False for a client-reported background agent. */
  interactive?: boolean;
  /** bind: the worker id this session's own claim_task returned. */
  workerId?: string;
  /** end: why. */
  reason?: LocalSessionEndReason;
  /**
   * touch: whether the client is inside a turn (true from the prompt or a tool
   * call starting, false at the turn's end). A long silent command fires no
   * hook until it returns, so this is how the server knows a quiet session is
   * still working. Absent: unchanged (and always absent from an older hook).
   */
  busy?: boolean;
  /**
   * start: the client session id this one continues in the same process (a
   * `/clear`). The claims that session held move to this one, so the cleared
   * conversation keeps them alive. Only a session of the same owner and client
   * that is still open or ended by `clear` is ever taken from.
   */
  continuesSessionId?: string;
  /** touch / end: cumulative usage per worker this session claimed. */
  usage?: LocalSessionUsage;
}

/** One model's usage: four disjoint token buckets, as the API reports them. */
export interface LocalSessionModelUsage {
  model: string;
  /** Uncached input (`input_tokens`). */
  input: number;
  /** `cache_read_input_tokens`. */
  cacheRead: number;
  /** `cache_creation_input_tokens` with the 5-minute TTL. */
  cacheWrite5m: number;
  /** `cache_creation_input_tokens` with the 1-hour TTL. */
  cacheWrite1h: number;
  output: number;
  /** API calls (distinct messages). */
  requests: number;
}

/**
 * Cumulative totals for one claimed worker since the session claimed it.
 * Replays are harmless: the server only ever raises stored totals.
 */
export interface LocalSessionWorkerUsage {
  workerId: string;
  models: LocalSessionModelUsage[];
  /** tool_use blocks the session (and its subagents) issued for this task. */
  toolCalls: number;
  /**
   * The same calls by tool name (`Bash`, `mcp__buildd__buildd`; `other` for a
   * name the hook would not send). Names and counts only. Absent from an older hook.
   */
  toolCounts?: Record<string, number>;
  /** Subagents whose usage is counted here. */
  subagents: number;
  /** ISO timestamps of the first and last counted API call. */
  firstAt?: string;
  lastAt?: string;
}

export interface LocalSessionUsage {
  workers: LocalSessionWorkerUsage[];
  /**
   * How this session's usage was charged, when the hook's environment settles
   * it: `real` (per token) or `virtual` (plan usage at list price); `unknown`
   * when it cannot tell. Absent from an older hook. Never `mixed`: that is a
   * server-side result (docs/specs/real-and-virtual-cost.md).
   */
  costBasis?: LocalSessionCostBasis;
}

export const LOCAL_SESSION_COST_BASES = ['real', 'virtual', 'unknown'] as const;
export type LocalSessionCostBasis = (typeof LOCAL_SESSION_COST_BASES)[number];

/** What the event endpoint answers. Hooks only read `pendingInstructions`. */
export interface LocalSessionEventResult {
  ok: true;
  sessionId: string | null;
  /** The task the session is bound to, when it is. */
  taskId: string | null;
  /**
   * True when buildd holds an instruction for the bound worker that the session
   * has not picked up. The hook only nudges the agent to call update_progress,
   * which is the existing delivery path; the text itself never rides here.
   */
  pendingInstructions: boolean;
  /** What the event did, for the hook's own debug log. */
  outcome: string;
}

/** A presence is shown as online while seen this recently (by hook or MCP). */
export const LOCAL_SESSION_ONLINE_MS = 10 * 60 * 1000;
/** Ended or offline sessions stay listed this long as "recently ended". */
export const LOCAL_SESSION_RECENT_MS = 24 * 60 * 60 * 1000;
/** Server-side write coalescing: at most one presence write a minute per session. */
export const LOCAL_SESSION_TOUCH_THROTTLE_MS = 60_000;

const MAX_ID = 200;
const MAX_VERSION = 64;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALLOWED_KEYS = new Set(['event', 'client', 'clientSessionId', 'clientVersion', 'repo', 'interactive', 'workerId', 'reason', 'usage', 'busy', 'continuesSessionId']);
const USAGE_KEYS = new Set(['workers', 'costBasis']);
const WORKER_USAGE_KEYS = new Set(['workerId', 'models', 'toolCalls', 'toolCounts', 'subagents', 'firstAt', 'lastAt']);
/** Same rule as the hook's TOOL_NAME_RE. */
const TOOL_NAME_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const MAX_TOOL_NAMES = 64;
const MODEL_USAGE_KEYS = new Set(['model', 'input', 'cacheRead', 'cacheWrite5m', 'cacheWrite1h', 'output', 'requests']);
const MODEL_ID_RE = /^[A-Za-z0-9._:/@\[\]-]{1,100}$/;
const MAX_USAGE_WORKERS = 20;
const MAX_USAGE_MODELS = 12;
const MAX_COUNT = 1e13;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= MAX_COUNT;
const onlyKeys = (o: Record<string, unknown>, allowed: Set<string>) => Object.keys(o).every(k => allowed.has(k));
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Strict: every level refuses unknown keys, so only counts and model ids can ride. */
function parseUsage(v: unknown): LocalSessionUsage | string {
  if (!isObject(v) || !onlyKeys(v, USAGE_KEYS) || !Array.isArray(v.workers)) return 'usage must be { workers: [...] }';
  if (v.workers.length > MAX_USAGE_WORKERS) return `usage.workers holds at most ${MAX_USAGE_WORKERS} entries`;
  if (v.costBasis !== undefined && !(LOCAL_SESSION_COST_BASES as readonly unknown[]).includes(v.costBasis)) {
    return 'usage.costBasis must be real, virtual or unknown';
  }
  const workers: LocalSessionWorkerUsage[] = [];
  for (const w of v.workers) {
    if (!isObject(w) || !onlyKeys(w, WORKER_USAGE_KEYS)) return 'usage.workers[] has an unknown field';
    if (typeof w.workerId !== 'string' || !UUID_RE.test(w.workerId)) return 'usage.workers[].workerId must be a full UUID';
    if (!Array.isArray(w.models) || w.models.length > MAX_USAGE_MODELS) return `usage.workers[].models must be an array of at most ${MAX_USAGE_MODELS}`;
    if (!isCount(w.toolCalls) || !isCount(w.subagents)) return 'usage.workers[].toolCalls and subagents must be non-negative integers';
    for (const t of [w.firstAt, w.lastAt]) {
      if (t !== undefined && (typeof t !== 'string' || !ISO_RE.test(t))) return 'usage.workers[].firstAt/lastAt must be ISO timestamps';
    }
    let toolCounts: Record<string, number> | undefined;
    if (w.toolCounts !== undefined) {
      if (!isObject(w.toolCounts)) return 'usage.workers[].toolCounts must map tool names to counts';
      const entries = Object.entries(w.toolCounts);
      if (entries.length > MAX_TOOL_NAMES) return `usage.workers[].toolCounts holds at most ${MAX_TOOL_NAMES} tool names`;
      for (const [name, n] of entries) {
        if (!TOOL_NAME_RE.test(name) || !isCount(n)) return 'usage.workers[].toolCounts must map tool names to non-negative integers';
      }
      toolCounts = Object.fromEntries(entries) as Record<string, number>;
    }
    const models: LocalSessionModelUsage[] = [];
    for (const m of w.models) {
      if (!isObject(m) || !onlyKeys(m, MODEL_USAGE_KEYS)) return 'usage.workers[].models[] has an unknown field';
      if (typeof m.model !== 'string' || !MODEL_ID_RE.test(m.model)) return 'usage.workers[].models[].model must be a model id';
      for (const k of ['input', 'cacheRead', 'cacheWrite5m', 'cacheWrite1h', 'output', 'requests'] as const) {
        if (!isCount(m[k])) return `usage.workers[].models[].${k} must be a non-negative integer`;
      }
      models.push({
        model: m.model, input: m.input as number, cacheRead: m.cacheRead as number, cacheWrite5m: m.cacheWrite5m as number,
        cacheWrite1h: m.cacheWrite1h as number, output: m.output as number, requests: m.requests as number,
      });
    }
    workers.push({
      workerId: w.workerId.toLowerCase(), models, toolCalls: w.toolCalls, subagents: w.subagents,
      ...(toolCounts ? { toolCounts } : {}),
      ...(w.firstAt !== undefined ? { firstAt: w.firstAt as string } : {}),
      ...(w.lastAt !== undefined ? { lastAt: w.lastAt as string } : {}),
    });
  }
  return { workers, ...(v.costBasis !== undefined ? { costBasis: v.costBasis as LocalSessionCostBasis } : {}) };
}

/**
 * Normalize a git remote (https, ssh, scp-like) to `owner/name`, dropping any
 * credentials, host and `.git`. Null when it does not look like one.
 */
export function normalizeRepoSlug(remote: string | null | undefined): string | null {
  if (!remote || typeof remote !== 'string') return null;
  let s = remote.trim();
  if (!s || s.length > 500) return null;
  s = s.replace(/\.git\/?$/, '').replace(/\/+$/, '');
  // scp-like: git@github.com:owner/name
  const scp = /^[^@/\s]+@[^:/\s]+:(.+)$/.exec(s);
  let path: string;
  if (scp) {
    path = scp[1];
  } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    try {
      path = new URL(s).pathname;
    } catch {
      return null;
    }
  } else {
    path = s;
  }
  const parts = path.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  const [owner, name] = parts.slice(-2);
  if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(name)) return null;
  return `${owner}/${name}`;
}

export type ParsedLocalSessionEvent =
  | { ok: true; event: LocalSessionEvent }
  | { ok: false; error: string };

/** Strict validation: unknown fields and out-of-vocabulary values are refused. */
export function parseLocalSessionEvent(body: unknown): ParsedLocalSessionEvent {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'body must be a JSON object' };
  const b = body as Record<string, unknown>;
  const unknownKeys = Object.keys(b).filter(k => !ALLOWED_KEYS.has(k));
  if (unknownKeys.length > 0) return { ok: false, error: `unknown field(s): ${unknownKeys.join(', ')}` };
  if (!(LOCAL_SESSION_EVENTS as readonly unknown[]).includes(b.event)) return { ok: false, error: `event must be one of ${LOCAL_SESSION_EVENTS.join('|')}` };
  if (!(LOCAL_CLIENT_KINDS as readonly unknown[]).includes(b.client)) return { ok: false, error: `client must be one of ${LOCAL_CLIENT_KINDS.join('|')}` };
  if (typeof b.clientSessionId !== 'string' || !b.clientSessionId.trim() || b.clientSessionId.length > MAX_ID) {
    return { ok: false, error: `clientSessionId must be a non-empty string of at most ${MAX_ID} characters` };
  }
  if (b.clientVersion !== undefined && (typeof b.clientVersion !== 'string' || b.clientVersion.length > MAX_VERSION)) {
    return { ok: false, error: `clientVersion must be a string of at most ${MAX_VERSION} characters` };
  }
  if (b.repo !== undefined && typeof b.repo !== 'string') return { ok: false, error: 'repo must be a string' };
  if (b.interactive !== undefined && typeof b.interactive !== 'boolean') return { ok: false, error: 'interactive must be a boolean' };
  if (b.event === 'bind') {
    if (typeof b.workerId !== 'string' || !UUID_RE.test(b.workerId)) return { ok: false, error: 'bind requires workerId (a full UUID)' };
  } else if (b.workerId !== undefined) {
    return { ok: false, error: 'workerId is only accepted on bind' };
  }
  if (b.reason !== undefined) {
    if (b.event !== 'end') return { ok: false, error: 'reason is only accepted on end' };
    if (!(LOCAL_SESSION_END_REASONS as readonly unknown[]).includes(b.reason)) {
      return { ok: false, error: `reason must be one of ${LOCAL_SESSION_END_REASONS.join('|')}` };
    }
  }
  if (b.busy !== undefined) {
    if (b.event !== 'touch') return { ok: false, error: 'busy is only accepted on touch' };
    if (typeof b.busy !== 'boolean') return { ok: false, error: 'busy must be a boolean' };
  }
  if (b.continuesSessionId !== undefined) {
    if (b.event !== 'start') return { ok: false, error: 'continuesSessionId is only accepted on start' };
    if (typeof b.continuesSessionId !== 'string' || !b.continuesSessionId.trim() || b.continuesSessionId.length > MAX_ID) {
      return { ok: false, error: `continuesSessionId must be a non-empty string of at most ${MAX_ID} characters` };
    }
  }
  let usage: LocalSessionUsage | undefined;
  if (b.usage !== undefined) {
    if (b.event !== 'touch' && b.event !== 'end') return { ok: false, error: 'usage is only accepted on touch and end' };
    const parsed = parseUsage(b.usage);
    if (typeof parsed === 'string') return { ok: false, error: parsed };
    usage = parsed;
  }
  const repo = b.repo === undefined ? undefined : normalizeRepoSlug(b.repo as string) ?? undefined;
  return {
    ok: true,
    event: {
      event: b.event as LocalSessionEventKind,
      client: b.client as LocalClientKind,
      clientSessionId: (b.clientSessionId as string).trim(),
      ...(b.clientVersion !== undefined ? { clientVersion: b.clientVersion as string } : {}),
      ...(repo ? { repo } : {}),
      ...(b.interactive !== undefined ? { interactive: b.interactive as boolean } : {}),
      ...(b.event === 'bind' ? { workerId: (b.workerId as string).toLowerCase() } : {}),
      ...(b.event === 'end' ? { reason: (b.reason as LocalSessionEndReason | undefined) ?? 'other' } : {}),
      ...(usage ? { usage } : {}),
      ...(b.busy !== undefined ? { busy: b.busy as boolean } : {}),
      ...(b.continuesSessionId !== undefined && (b.continuesSessionId as string).trim() !== (b.clientSessionId as string).trim()
        ? { continuesSessionId: (b.continuesSessionId as string).trim() }
        : {}),
    },
  };
}

/** Display label for a client kind. */
export function localClientLabel(kind: string | null | undefined): string {
  switch (kind) {
    case 'claude': return 'Claude Code';
    case 'codex': return 'Codex';
    case 'cursor': return 'Cursor';
    default: return 'Local agent';
  }
}
