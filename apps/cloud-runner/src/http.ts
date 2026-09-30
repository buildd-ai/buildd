/**
 * The dispatcher Worker's HTTP surface. Runtime-free: the agent lookup is
 * passed in, so Bun tests drive it with a stub namespace.
 *
 *   POST /dispatch        buildd's task webhook (task-dispatch.ts). 202 fast.
 *   GET  /tasks/:taskId   the task's WorkerAgent state, for debugging.
 *
 * Both require `Authorization: Bearer <DISPATCH_TOKEN>`, the token set in the
 * workspace's webhookConfig.
 */
import { isValidTaskId, type RunState } from './lifecycle';
import type { DispatchResult } from './supervisor';

export interface DispatcherEnv {
  DISPATCH_TOKEN?: string;
  BUILDD_SERVER?: string;
  BUILDD_API_KEY?: string;
}

/** The RPC surface of a WorkerAgent stub that the Worker calls. */
export interface AgentHandle {
  dispatch(): Promise<DispatchResult>;
  getRunState(): Promise<RunState>;
}

export type GetAgent = (taskId: string) => Promise<AgentHandle>;

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

export async function handleRequest(request: Request, env: DispatcherEnv, getAgent: GetAgent): Promise<Response> {
  const url = new URL(request.url);
  const isDispatch = url.pathname === '/dispatch';
  const taskMatch = /^\/tasks\/([^/]+)$/.exec(url.pathname);
  if (!isDispatch && !taskMatch) return json({ error: 'not_found' }, 404);

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

    const agent = await getAgent(taskId);
    const result = await agent.dispatch();
    // 202 for a duplicate too: buildd treats a non-2xx as "webhook failed" and
    // falls back to Pusher, which would let a polling runner race this one.
    return json({ taskId, ...result }, 202);
  }

  if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
  let taskId: string;
  try {
    taskId = decodeURIComponent(taskMatch![1]!);
  } catch {
    return json({ error: 'invalid_task_id' }, 400);
  }
  if (!isValidTaskId(taskId)) return json({ error: 'invalid_task_id' }, 400);
  const agent = await getAgent(taskId);
  return json(await agent.getRunState(), 200);
}
