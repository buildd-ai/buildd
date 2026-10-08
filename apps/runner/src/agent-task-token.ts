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

/**
 * Orchestration tasks (organizer, planning, heartbeat) use admin-level buildd
 * actions, so they ask for an admin-level per-task token (`level: 'admin'`),
 * which the server grants only to an admin runner key and confines to the
 * task's own mission. When it is refused (a worker-level runner key, a
 * coordination workspace, an older server) the session keeps the runner key,
 * as orchestration always did. The rule lives in @buildd/shared.
 */
export { isOrchestrationTask } from '@buildd/shared';

/**
 * Roles whose own deliverable IS an admin-level buildd action, so a
 * worker-level task token cannot do their job at all. Not orchestration (they
 * coordinate nothing and get no PR exemptions), they just need the runner key
 * for the agent's buildd MCP, like orchestration does.
 *  - consolidator: the weekly knowledge pass is consolidate_knowledge
 *    (find_duplicates / find_decayed / archive), which is admin-only.
 */
export const ADMIN_ACTION_ROLES: ReadonlySet<string> = new Set(['consolidator']);

export function usesAdminBuilddActions(task: { roleSlug?: string | null } | null | undefined): boolean {
  return !!task?.roleSlug && ADMIN_ACTION_ROLES.has(task.roleSlug);
}

export interface ParsedTaskToken {
  token: string;
  expiresAt: number;
}

/**
 * Strict parse of the mint response. Throws a message that never contains the token.
 * For an admin request the response must say `level: 'admin'`: a server that
 * predates levels ignores the field and mints a worker token, which would
 * break an orchestration session, so that counts as a refusal.
 */
export function parseAgentTaskTokenResponse(body: unknown, taskId: string, now = Date.now(), level: AgentTaskTokenLevel = 'worker'): ParsedTaskToken {
  const b = (body ?? {}) as { token?: unknown; taskId?: unknown; expiresAt?: unknown; level?: unknown };
  if (typeof b.token !== 'string' || !b.token.startsWith(TASK_TOKEN_PREFIX) || b.token.length <= TASK_TOKEN_PREFIX.length) {
    throw new Error('response has no per-task token');
  }
  if (b.taskId !== taskId) throw new Error('response is for a different task');
  const expiresAt = typeof b.expiresAt === 'string' ? Date.parse(b.expiresAt) : NaN;
  if (!Number.isFinite(expiresAt)) throw new Error('response has no valid expiresAt');
  if (expiresAt <= now) throw new Error('response token is already expired');
  if (level === 'admin' && b.level !== 'admin') throw new Error('server did not grant an admin token');
  return { token: b.token, expiresAt };
}

export type AgentTaskTokenLevel = 'worker' | 'admin';

/**
 * The mint call. Resolves to the parsed JSON body on 2xx; rejects otherwise.
 * A rejection may carry a numeric `status` (BuilddClient's ServerRefusalError does).
 * `level` is passed only for an admin request.
 */
export type MintTaskTokenFn = (taskId: string, ttlMs: number, signal: AbortSignal, level?: 'admin') => Promise<unknown>;

export type AgentBuilddAuth =
  | { source: 'task-token'; token: string; expiresAt: number; level: AgentTaskTokenLevel }
  | { source: 'runner-key'; token: string; reason: 'disabled' | 'runner-key-is-task-token' | 'orchestration-role' | 'admin-role' | 'mint-failed'; detail?: string };

/** Short, secret-free reason for a mint failure. */
export function describeMintFailure(err: unknown, level: AgentTaskTokenLevel = 'worker'): string {
  const status = typeof (err as { status?: unknown })?.status === 'number' ? (err as { status: number }).status : undefined;
  if (status === 401) return 'HTTP 401 (key not accepted for minting)';
  if (status === 403 && level === 'admin') return 'HTTP 403 (key is not an admin key, or the task is not an orchestration task in a workspace with a repo)';
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
  /** isOrchestrationTask(task): mint an admin-level token; if refused, the runner key with one info line. */
  orchestration?: boolean;
  /** usesAdminBuilddActions(task): keep the runner key, no mint, one info line. */
  adminRole?: boolean;
  info?: (line: string) => void;
  env?: Record<string, string | undefined>;
  warn?: (line: string) => void;
  timeoutMs?: number;
  now?: () => number;
}): Promise<AgentBuilddAuth> {
  const { runnerKey, taskId } = opts;
  const warn = opts.warn ?? ((l: string) => console.warn(l));
  const info = opts.info ?? ((l: string) => console.log(l));
  const now = opts.now ?? Date.now;

  if (!agentTaskTokenEnabled(opts.env)) {
    return { source: 'runner-key', token: runnerKey, reason: 'disabled' };
  }
  // The runner already runs on a task token (cloud container): it cannot mint
  // another one, and it is already the run's own identity.
  if (runnerKey?.startsWith(TASK_TOKEN_PREFIX)) {
    return { source: 'runner-key', token: runnerKey, reason: 'runner-key-is-task-token' };
  }

  // Checked before orchestration: an admin task token does not carry these
  // roles' actions (consolidate_knowledge is team-wide), so they keep the key.
  if (opts.adminRole) {
    info(`[agent-task-token] task ${(taskId ?? '').slice(0, 8)}: role needs admin-level buildd actions a task token does not carry; the agent's buildd MCP calls use the runner key (source=runner-key reason=admin-role).`);
    return { source: 'runner-key', token: runnerKey, reason: 'admin-role' };
  }

  const level: AgentTaskTokenLevel = opts.orchestration ? 'admin' : 'worker';
  let detail: string;
  try {
    if (!opts.mint) throw new Error('client cannot mint task tokens');
    if (!taskId) throw new Error('no task id');
    const signal = AbortSignal.timeout(opts.timeoutMs ?? AGENT_TASK_TOKEN_MINT_TIMEOUT_MS);
    const body = level === 'admin'
      ? await opts.mint(taskId, AGENT_TASK_TOKEN_TTL_MS, signal, 'admin')
      : await opts.mint(taskId, AGENT_TASK_TOKEN_TTL_MS, signal);
    const parsed = parseAgentTaskTokenResponse(body, taskId, now(), level);
    return { source: 'task-token', token: parsed.token, expiresAt: parsed.expiresAt, level };
  } catch (err) {
    detail = describeMintFailure(err, level);
  }
  if (opts.orchestration) {
    // Expected on a worker-level runner key, in a coordination workspace and
    // against an older server: the session runs as orchestration always did.
    info(`[agent-task-token] task ${(taskId ?? '').slice(0, 8)}: orchestration task (organizer role, planning mode or heartbeat); no admin per-task token (${detail}); the agent's buildd MCP calls use the runner key (source=runner-key reason=orchestration-role).`);
    return { source: 'runner-key', token: runnerKey, reason: 'orchestration-role', detail };
  }
  warn(`[agent-task-token] task ${taskId.slice(0, 8)}: could not mint a per-task token (${detail}); the agent's buildd MCP calls use the runner key for this session.`);
  return { source: 'runner-key', token: runnerKey, reason: 'mint-failed', detail };
}
