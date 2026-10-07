/**
 * The dispatcher Worker's HTTP surface. Runtime-free: the agent lookup is
 * passed in, so Bun tests drive it with a stub namespace.
 *
 *   POST /dispatch        buildd's task webhook (task-dispatch.ts). 202 fast.
 *                         `event: 'task.resume'` + `workerId` continues a parked worker.
 *                         `event: 'task.scheduled'` + `notBefore` (ISO) starts it then.
 *   GET  /tasks/:taskId   the task's WorkerAgent state, for debugging.
 *
 * Both require `Authorization: Bearer <DISPATCH_TOKEN>`, the token set in the
 * workspace's webhookConfig.
 *
 * Two agent classes, one per container size (runner-class.ts). A dispatch
 * goes to the class buildd names for the task (`resolveSize`); a resume to the
 * class whose agent parked that worker; GET and kill to whichever class holds
 * the task's latest run.
 */
import { isValidTaskId, type DispatchRequest, type RunState } from './lifecycle';
import type { DispatchResult, ScheduleDispatchResult } from './supervisor';
import { FALLBACK_DECISION, type RunnerSize, type RunnerSizeDecision } from './runner-class';

/**
 * How far ahead a `task.scheduled` may point. buildd sends nothing further
 * than this (task-dispatch.ts SCHEDULED_DISPATCH_MAX_AHEAD_MS); the slack
 * covers the two clocks disagreeing.
 */
export const SCHEDULE_MAX_AHEAD_MS = 24 * 60 * 60 * 1000;
export const SCHEDULE_CLOCK_SKEW_MS = 5 * 60 * 1000;

/** Strict-ish ISO 8601 date-time, so a bare number or a word is never a date. */
const ISO_DATE_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;

function parseNotBefore(v: unknown): number | null {
  if (typeof v !== 'string' || !ISO_DATE_TIME_RE.test(v)) return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
}

export interface DispatcherEnv {
  DISPATCH_TOKEN?: string;
  BUILDD_SERVER?: string;
  BUILDD_API_KEY?: string;
  /** `1` enables POST /tasks/:id/kill, for recovery testing. Off by default. */
  ALLOW_DEBUG_KILL?: string;
}

/** The RPC surface of a WorkerAgent stub that the Worker calls. */
export interface AgentHandle {
  dispatch(request?: DispatchRequest): Promise<DispatchResult>;
  /** `task.scheduled`: start a run at `notBefore` (epoch ms); a past one starts now. */
  scheduleDispatch(notBefore: number, runnerSize?: RunnerSizeDecision): Promise<ScheduleDispatchResult>;
  getRunState(): Promise<RunState>;
  /** Destroy the task's container, as an OOM kill or platform stop would. */
  killContainer(): Promise<{ killed: boolean }>;
}

/** The task's agent in one class. `size` absent: standard. */
export type GetAgent = (taskId: string, size?: RunnerSize) => Promise<AgentHandle>;

/** buildd's answer to "which class" (runner-class.ts fetchRunnerSize). Never throws. */
export type ResolveSize = (taskId: string, workerId?: string) => Promise<RunnerSizeDecision>;

export interface HandlerOptions {
  /** Absent: every task is standard (the single-class behaviour). */
  resolveSize?: ResolveSize;
}

const otherSize = (size: RunnerSize): RunnerSize => (size === 'large' ? 'standard' : 'large');
const isLive = (s: RunState) => s.status === 'starting' || s.status === 'running';

/**
 * Which class holds the task's latest run: a live one first, else the later
 * start, else standard. For GET and kill, which have no size to go by.
 */
async function agentWithLatestRun(getAgent: GetAgent, taskId: string): Promise<{ agent: AgentHandle; state: RunState }> {
  const standard = await getAgent(taskId, 'standard');
  const stdState = await standard.getRunState();
  if (isLive(stdState)) return { agent: standard, state: stdState };
  const large = await getAgent(taskId, 'large');
  const largeState = await large.getRunState();
  if (isLive(largeState) || (largeState.startedAt ?? 0) > (stdState.startedAt ?? 0)) return { agent: large, state: largeState };
  return { agent: standard, state: stdState };
}

/**
 * A resume must reach the agent that parked the worker, whatever buildd says
 * now (its answer is a first guess: the class may have changed since the park,
 * or buildd may not have answered). The other class is asked only when the
 * guess does not hold it.
 */
async function agentForResume(getAgent: GetAgent, taskId: string, workerId: string, guess: RunnerSize): Promise<{ agent: AgentHandle; size: RunnerSize }> {
  const parks = (s: RunState) => s.status === 'exited' && s.outcome === 'parked' && s.workerId === workerId;
  const first = await getAgent(taskId, guess);
  if (parks(await first.getRunState())) return { agent: first, size: guess };
  const other = await getAgent(taskId, otherSize(guess));
  if (parks(await other.getRunState())) return { agent: other, size: otherSize(guess) };
  return { agent: first, size: guess };
}

const MAX_BODY_BYTES = 64 * 1024;

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
}

/**
 * Constant-time string comparison. Both sides are hashed first so the loop is
 * always 32 bytes and neither the length nor the first differing byte leaks.
 */
export async function timingSafeEqualString(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([sha256(a), sha256(b)]);
  let diff = 0;
  for (let i = 0; i < ha.length; i++) diff |= ha[i]! ^ hb[i]!;
  return diff === 0;
}

export async function isAuthorized(request: Request, expected: string | undefined): Promise<boolean> {
  if (!expected) return false;
  const header = request.headers.get('Authorization') ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) return false;
  return timingSafeEqualString(match[1]!.trim(), expected);
}

/** Missing config fails closed: an unset BUILDD_SERVER would make the runner default to production. */
function missingConfig(env: DispatcherEnv): string[] {
  return (['DISPATCH_TOKEN', 'BUILDD_SERVER', 'BUILDD_API_KEY'] as const).filter(k => !env[k]);
}

export async function handleRequest(
  request: Request,
  env: DispatcherEnv,
  getAgent: GetAgent,
  now: () => number = () => Date.now(),
  opts: HandlerOptions = {},
): Promise<Response> {
  const resolveSize: ResolveSize = opts.resolveSize ?? (async () => FALLBACK_DECISION);
  const url = new URL(request.url);
  const isDispatch = url.pathname === '/dispatch';
  const taskMatch = /^\/tasks\/([^/]+)$/.exec(url.pathname);
  // Debug only: absent (404) unless the operator opted in with ALLOW_DEBUG_KILL=1.
  const killMatch = env.ALLOW_DEBUG_KILL === '1' ? /^\/tasks\/([^/]+)\/kill$/.exec(url.pathname) : null;
  if (!isDispatch && !taskMatch && !killMatch) return json({ error: 'not_found' }, 404);

  const missing = missingConfig(env);
  if (missing.length > 0) {
    console.error(`[cloud-runner] not configured: missing ${missing.join(', ')}`);
    return json({ error: 'not_configured' }, 500);
  }
  if (!(await isAuthorized(request, env.DISPATCH_TOKEN))) {
    return json({ error: 'unauthorized' }, 401);
  }

  if (isDispatch) {
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) return json({ error: 'body_too_large' }, 413);
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return json({ error: 'invalid_json' }, 400);
    }
    const taskId = (body as { taskId?: unknown } | null)?.taskId;
    if (!isValidTaskId(taskId)) return json({ error: 'invalid_task_id' }, 400);
    const b = body as { event?: unknown; workerId?: unknown; notBefore?: unknown };
    if (b.event === 'task.scheduled') {
      const notBefore = parseNotBefore(b.notBefore);
      if (notBefore === null) return json({ error: 'invalid_not_before' }, 400);
      if (notBefore - now() > SCHEDULE_MAX_AHEAD_MS + SCHEDULE_CLOCK_SKEW_MS) {
        return json({ error: 'not_before_too_far' }, 400);
      }
      const runnerSize = await resolveSize(taskId);
      const agent = await getAgent(taskId, runnerSize.size);
      return json({ taskId, runnerSize: runnerSize.size, ...(await agent.scheduleDispatch(notBefore, runnerSize)) }, 202);
    }
    const dispatchRequest: DispatchRequest = {};
    if (b.event === 'task.resume') {
      // Worker IDs share the task ID shape (uuid-like tokens, never flags or paths).
      if (!isValidTaskId(b.workerId)) return json({ error: 'invalid_worker_id' }, 400);
      dispatchRequest.resumeWorkerId = b.workerId;
    }

    // The class comes from buildd (runner size route), never from the body.
    const runnerSize = await resolveSize(taskId, dispatchRequest.resumeWorkerId);
    let agent: AgentHandle;
    let size = runnerSize.size;
    if (dispatchRequest.resumeWorkerId) {
      ({ agent, size } = await agentForResume(getAgent, taskId, dispatchRequest.resumeWorkerId, runnerSize.size));
    } else {
      agent = await getAgent(taskId, size);
    }
    dispatchRequest.runnerSize = size === runnerSize.size ? runnerSize : { size, source: 'pinned', reason: null };
    // Container reuse keys on the workspace buildd named (container-lease.ts), never the body's.
    if (!dispatchRequest.resumeWorkerId && runnerSize.workspaceId) dispatchRequest.workspaceId = runnerSize.workspaceId;
    const result = await agent.dispatch(dispatchRequest);
    // 202 for a duplicate too: buildd treats a non-2xx as "webhook failed" and
    // falls back to Pusher, which would let a polling runner race this one.
    return json({ taskId, runnerSize: size, ...result }, 202);
  }

  if (killMatch) {
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
    let killId: string;
    try {
      killId = decodeURIComponent(killMatch[1]!);
    } catch {
      return json({ error: 'invalid_task_id' }, 400);
    }
    if (!isValidTaskId(killId)) return json({ error: 'invalid_task_id' }, 400);
    const { agent } = await agentWithLatestRun(getAgent, killId);
    return json({ taskId: killId, ...(await agent.killContainer()) }, 200);
  }

  if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
  let taskId: string;
  try {
    taskId = decodeURIComponent(taskMatch![1]!);
  } catch {
    return json({ error: 'invalid_task_id' }, 400);
  }
  if (!isValidTaskId(taskId)) return json({ error: 'invalid_task_id' }, 400);
  const { state } = await agentWithLatestRun(getAgent, taskId);
  return json(state, 200);
}
