// The buildd agent plugin's session-event contract.
//
// A person's interactive coding client (Claude Code, Codex, Cursor) runs the
// plugin's lifecycle hooks; each hook normalizes its client's payload into ONE
// of these events and POSTs it to /api/workers/local-sessions. That is the
// whole wire format: four typed events, no free text. It carries no
// transcript, prompt, response, reasoning or secret, and the server rejects
// any field it does not know.
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
}

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
const ALLOWED_KEYS = new Set(['event', 'client', 'clientSessionId', 'clientVersion', 'repo', 'interactive', 'workerId', 'reason']);

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
