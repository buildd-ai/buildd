/**
 * POST /api/runner/model-endpoint
 *
 * The team's agent model endpoint for ONE cloud task, for the cloud runner's
 * dispatcher (apps/cloud-runner). The dispatcher's egress handler applies it
 * to the container's model requests; the container never receives it (the
 * claim strips `modelEndpoint` for `executor: 'cloud'`).
 *
 * Auth is exactly /api/runner/github-token's:
 *   Authorization: Bearer <runner API key>   the account that claimed the task
 *   X-Buildd-Dispatch-Token: <token>         the workspace's webhookConfig.token
 * The container holds the API key but never the dispatch token.
 *
 * Body: { taskId, workerId? }. Refused unless the task's workspace is one the
 * account may claim from, the dispatch token matches that workspace's enabled
 * webhook, and the task has a live worker owned by the calling account (and,
 * when workerId is given, it is that worker).
 *
 * Applies the same ranking as the claim (packages/core/agent-endpoint.ts,
 * `resolveAgentModelRoute`) but only ever returns an endpoint: a task whose
 * winner is an Anthropic key or seat, a codex task, or a team with no endpoint
 * gets 404 and egress falls through to the Worker's own route.
 *
 * Design: docs/design/agent-model-endpoint.md §3.
 */
import { NextRequest, NextResponse } from 'next/server';
import { createHash, timingSafeEqual } from 'crypto';
import { db } from '@buildd/core/db';
import { tasks, workers } from '@buildd/core/db/schema';
import { and, eq, inArray } from 'drizzle-orm';
import { resolveAgentModelRoute } from '@buildd/core/agent-endpoint';
import { authenticateApiKey } from '@/lib/api-auth';
import { tokenWorkspaceAllowed } from '@buildd/core/token-scopes';
import { getAccountWorkspacePermissions } from '@/lib/account-workspace-cache';
import { LIVE_WORKER_STATUSES } from '@/lib/task-presentation';
import { isOpenWithinTeams } from '@/lib/open-workspaces';

/** Mirrors DISPATCH_TOKEN_HEADER in apps/cloud-runner/src/outbound.ts. */
const DISPATCH_TOKEN_HEADER = 'x-buildd-dispatch-token';

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const NO_STORE = { 'Cache-Control': 'no-store' };

function fail(status: number, error: string) {
  return NextResponse.json({ error }, { status, headers: NO_STORE });
}

/** Constant-time over fixed-length digests, so neither length nor prefix leaks. */
function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

export async function POST(req: NextRequest) {
  const apiKey = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? null;
  // Pass the request: without it a capability-scoped key is refused outright.
  const account = await authenticateApiKey(apiKey, req);
  if (!account) return fail(401, 'Unauthorized');
  if (account.level === 'trigger') return fail(403, 'Trigger tokens cannot request a model endpoint');

  const dispatchToken = req.headers.get(DISPATCH_TOKEN_HEADER);
  if (!dispatchToken) return fail(401, 'Dispatch token required');

  let body: { taskId?: unknown; workerId?: unknown };
  try {
    body = await req.json();
  } catch {
    return fail(400, 'Invalid JSON body');
  }
  const { taskId, workerId } = body ?? {};
  if (typeof taskId !== 'string' || !ID_RE.test(taskId)) return fail(400, 'taskId is required');
  if (workerId !== undefined && (typeof workerId !== 'string' || !ID_RE.test(workerId))) {
    return fail(400, 'workerId must be an id');
  }

  const task = await db.query.tasks.findFirst({
    where: eq(tasks.id, taskId),
    columns: { id: true, workspaceId: true, backend: true },
    with: {
      workspace: { columns: { id: true, teamId: true, accessMode: true, webhookConfig: true } },
    },
  });
  const ws = task?.workspace;
  // Every "not yours" answer is the same 404.
  if (!task || !ws || task.workspaceId !== ws.id) return fail(404, 'Task not found');

  // A workspace-restricted token acts only inside its own list.
  if (!tokenWorkspaceAllowed(account.workspaceIds, ws.id)) return fail(404, 'Task not found');
  const ownOpen = !!account.teamId && isOpenWithinTeams(ws, [account.teamId]);
  if (!ownOpen) {
    const perms = await getAccountWorkspacePermissions(account.id);
    if (!perms.some(p => p.workspaceId === ws.id && p.canClaim)) return fail(404, 'Task not found');
  }

  const hook = ws.webhookConfig;
  if (!hook || !hook.enabled || typeof hook.token !== 'string' || hook.token.length === 0 || !safeEqual(hook.token, dispatchToken)) {
    return fail(403, 'Dispatch token does not match this workspace');
  }

  const liveWorkers = await db.query.workers.findMany({
    where: and(eq(workers.taskId, taskId), inArray(workers.status, [...LIVE_WORKER_STATUSES])),
    columns: { id: true, accountId: true, workspaceId: true, status: true, taskId: true },
  });
  const live = new Set<string>(LIVE_WORKER_STATUSES);
  const mine = liveWorkers.filter(w =>
    w.taskId === taskId &&
    w.workspaceId === ws.id &&
    w.accountId === account.id &&
    live.has(w.status) &&
    (workerId === undefined || w.id === workerId));
  if (mine.length === 0) return fail(409, 'Task has no live worker claimed by this account');

  // Codex speaks the OpenAI Responses API with its own credential (§2).
  if ((task as { backend?: string | null }).backend === 'codex') return fail(404, 'No agent model endpoint for this task');

  try {
    const decision = await resolveAgentModelRoute({ teamId: ws.teamId, workspaceId: ws.id, accountId: account.id });
    if (!decision || decision.winner !== 'endpoint') return fail(404, 'No agent model endpoint for this task');
    const e = decision.endpoint;
    return NextResponse.json(
      { kind: e.kind, baseUrl: e.baseUrl, key: e.apiKey, authHeader: e.authHeader, models: e.models },
      { headers: NO_STORE },
    );
  } catch {
    // The error could carry decrypted material; log nothing of it.
    console.error(`[model-endpoint] resolution failed for task ${taskId}`);
    return fail(500, 'Could not resolve the model endpoint');
  }
}
