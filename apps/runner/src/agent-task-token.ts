/**
 * Per-task token for the AGENT's buildd MCP calls.
 *
 * The runner process authenticates its own calls (claim, worker PATCH,
 * heartbeat, ...) with its runner key. The agent session it spawns should not
 * carry that key: every buildd call the agent makes should carry its own run's
 * identity. At each session start the runner mints a per-task token
 * (`bldt_…`, `POST /api/runner/task-token`) and hands only that to the agent's
 * buildd MCP auth — the Claude `mcpServers.buildd` Authorization header and the
 * Codex `BUILDD_MCP_BEARER_TOKEN` env.
 *
 * This mirrors the cloud dispatcher (apps/cloud-runner/src/lifecycle.ts
 * `taskTokenRequest` / `parseTaskTokenResponse`), where the container's whole
 * process runs on a task token.
 *
 * Minting never blocks a session: on any failure the session falls back to the
 * runner key and logs one warning line with the reason (never the token, never
 * the response body).
 *
 * Escape hatch: `BUILDD_AGENT_TASK_TOKEN=0` keeps the runner key for the agent
 * and skips the mint call.
 */

export const TASK_TOKEN_PATH = '/api/runner/task-token';
export const TASK_TOKEN_PREFIX = 'bldt_';
/** Server maximum (apps/web/src/lib/task-token.ts TASK_TOKEN_MAX_TTL_MS). Re-minted per session start. */
export const AGENT_TASK_TOKEN_TTL_MS = 12 * 60 * 60 * 1000;
/** A session start waits at most this long for the mint before falling back. */
export const AGENT_TASK_TOKEN_MINT_TIMEOUT_MS = 10_000;
export const AGENT_TASK_TOKEN_ENV = 'BUILDD_AGENT_TASK_TOKEN';

/** On unless explicitly turned off with `BUILDD_AGENT_TASK_TOKEN=0` (or false/off/no). */
export function agentTaskTokenEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const v = env[AGENT_TASK_TOKEN_ENV]?.trim().toLowerCase();
  return !(v === '0' || v === 'false' || v === 'off' || v === 'no');
}

export interface ParsedTaskToken {
  token: string;
  expiresAt: number;
}

/** Strict parse of the mint response. Throws a message that never contains the token. */
export function parseAgentTaskTokenResponse(body: unknown, taskId: string, now = Date.now()): ParsedTaskToken {
  const b = (body ?? {}) as { token?: unknown; taskId?: unknown; expiresAt?: unknown };
  if (typeof b.token !== 'string' || !b.token.startsWith(TASK_TOKEN_PREFIX) || b.token.length <= TASK_TOKEN_PREFIX.length) {
    throw new Error('response has no per-task token');
  }
  if (b.taskId !== taskId) throw new Error('response is for a different task');
  const expiresAt = typeof b.expiresAt === 'string' ? Date.parse(b.expiresAt) : NaN;
  if (!Number.isFinite(expiresAt)) throw new Error('response has no valid expiresAt');
  if (expiresAt <= now) throw new Error('response token is already expired');
  return { token: b.token, expiresAt };
}

/**
 * The mint call. Resolves to the parsed JSON body on 2xx; rejects otherwise.
 * A rejection may carry a numeric `status` (BuilddClient's ServerRefusalError does).
 */
export type MintTaskTokenFn = (taskId: string, ttlMs: number, signal: AbortSignal) => Promise<unknown>;

export type AgentBuilddAuth =
  | { source: 'task-token'; token: string; expiresAt: number }
  | { source: 'runner-key'; token: string; reason: 'disabled' | 'runner-key-is-task-token' | 'mint-failed'; detail?: string };

/** Short, secret-free reason for a mint failure. */
export function describeMintFailure(err: unknown): string {
  const status = typeof (err as { status?: unknown })?.status === 'number' ? (err as { status: number }).status : undefined;
  if (status === 401) return 'HTTP 401 (key not accepted for minting)';
  if (status === 403) return 'HTTP 403 (key lacks the runner scopes, or is a trigger key)';
  if (status === 404) return 'HTTP 404 (server has no task-token route, or the key cannot claim in this workspace)';
  if (status === 503) return 'HTTP 503 (server has no task-token signing secret)';
  if (status !== undefined) return `HTTP ${status}`;
  const name = (err as { name?: unknown })?.name;
  if (name === 'TimeoutError' || name === 'AbortError') return 'timed out';
  if (err instanceof TypeError) return 'network error';
  const msg = err instanceof Error ? err.message : String(err);
  // Our own parse errors are fixed strings; anything else is truncated and
  // stripped of anything token-shaped in case a body leaked into a message.
  return msg.replace(/\b(bldt?_)[A-Za-z0-9._\-]+/g, '$1[redacted]').slice(0, 160);
}

/**
 * Pick the credential for the agent's buildd MCP auth for one session.
 * Never throws: any failure is a fallback to the runner key with one warning.
 */
export async function resolveAgentBuilddAuth(opts: {
  runnerKey: string;
  taskId: string;
  mint: MintTaskTokenFn | undefined;
  env?: Record<string, string | undefined>;
  warn?: (line: string) => void;
  timeoutMs?: number;
  now?: () => number;
}): Promise<AgentBuilddAuth> {
  const { runnerKey, taskId } = opts;
  const warn = opts.warn ?? ((l: string) => console.warn(l));
  const now = opts.now ?? Date.now;

  if (!agentTaskTokenEnabled(opts.env)) {
    return { source: 'runner-key', token: runnerKey, reason: 'disabled' };
  }
  // The runner already runs on a task token (cloud container): it cannot mint
  // another one, and it is already the run's own identity.
  if (runnerKey?.startsWith(TASK_TOKEN_PREFIX)) {
    return { source: 'runner-key', token: runnerKey, reason: 'runner-key-is-task-token' };
  }

  let detail: string;
  try {
    if (!opts.mint) throw new Error('client cannot mint task tokens');
    if (!taskId) throw new Error('no task id');
    const signal = AbortSignal.timeout(opts.timeoutMs ?? AGENT_TASK_TOKEN_MINT_TIMEOUT_MS);
    const body = await opts.mint(taskId, AGENT_TASK_TOKEN_TTL_MS, signal);
    const parsed = parseAgentTaskTokenResponse(body, taskId, now());
    return { source: 'task-token', token: parsed.token, expiresAt: parsed.expiresAt };
  } catch (err) {
    detail = describeMintFailure(err);
  }
  warn(`[agent-task-token] task ${taskId.slice(0, 8)}: could not mint a per-task token (${detail}); the agent's buildd MCP calls use the runner key for this session.`);
  return { source: 'runner-key', token: runnerKey, reason: 'mint-failed', detail };
}
