import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { tasks, workers } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateTaskScopedCaller, taskScopeAllowsWorkspace } from '@/lib/task-token-auth';
import { verifyWorkspaceAccess, verifyAccountWorkspaceAccess } from '@/lib/team-access';
import { loadDiscoveryInput } from '@/lib/connector-capabilities-store';
import { listCapabilities, resolveCapability, resolveProviderAccess, type CapabilityResolution } from '@/lib/connector-capabilities';
import { recordCapabilityDecision } from '@/lib/agent-capabilities/audit';
import { sqlWhere } from '@buildd/core/db/relational-sql';

const ROLE_SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * With `workerId` (the MCP passes the caller's own), the search is recorded
 * against that worker (`capability.resolve`): a `blockedByCapability`
 * completion is accepted only after the worker asked (lib/capability-blocker.ts).
 * Recorded only for the caller's own worker on a task in this workspace;
 * anything else is answered the same and not recorded.
 */
async function recordResolve(
  account: { id: string; taskScope?: { taskId: string } } | null,
  workerId: string | null,
  workspaceId: string,
  ask: { capability: string | null; provider: string | null; access: string | null },
  result: CapabilityResolution,
): Promise<void> {
  if (!account || !workerId || !UUID_RE.test(workerId)) return;
  const worker = await db.query.workers.findFirst({
    where: sqlWhere(eq(workers.id, workerId)),
    columns: { id: true, accountId: true, taskId: true, workspaceId: true },
  });
  if (!worker || worker.accountId !== account.id || worker.workspaceId !== workspaceId || !worker.taskId) return;
  if (account.taskScope && account.taskScope.taskId !== worker.taskId) return;
  // Serves = an installed connector the team has not forbidden; the agent's next step is request_capability.
  const providers = [...new Set(result.candidates
    .filter(c => c.connector && c.access !== 'forbidden' && c.provider.slug)
    .map(c => c.provider.slug as string))];
  await recordCapabilityDecision({
    capability: 'capability.resolve',
    decision: 'allowed',
    workspaceId, taskId: worker.taskId, workerId: worker.id, accountId: account.id,
    principalVia: account.taskScope ? 'task_token' : 'runner_key',
    resource: result.capability,
    reasonCode: providers.length > 0 ? 'served' : 'none',
    sideEffect: { capability: ask.capability ?? result.capability, provider: ask.provider, access: ask.access, providers: providers.slice(0, 5) },
  });
}

// GET /api/connectors/capabilities?workspaceId=<id>[&capability=observability:query][&roleSlug=builder]
//
// Read-only semantic capability discovery over the workspace's connectors,
// roles, credential health and the team's catalog policy. `capability` is a
// category search filter (which providers serve domain:verb); it is not what
// an agent requests or is granted (that is request_capability { provider,
// access }). With `provider` (+ `access`, default read) it shows one provider's
// state for this workspace; with neither it lists every category something serves. Backs the resolve_capability MCP action. Same reach as
// /api/connectors/mounted: a per-task token sees only its own task's workspace, and defaults roleSlug to its own task's role.
// Changes nothing: installing, enabling or granting stays an admin act.
export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  const apiAccount = await authenticateTaskScopedCaller(apiKey, req);

  if (!user && !apiAccount) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const params = req.nextUrl.searchParams;
  const workspaceId = params.get('workspaceId');
  if (!workspaceId) {
    return NextResponse.json({ error: 'workspaceId is required' }, { status: 400 });
  }

  if (user && !apiAccount) {
    const access = await verifyWorkspaceAccess(user.id, workspaceId);
    if (!access) return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
  } else if (apiAccount) {
    if (!taskScopeAllowsWorkspace(apiAccount, workspaceId)) return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
    const hasAccess = await verifyAccountWorkspaceAccess(apiAccount, workspaceId);
    if (!hasAccess) return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
  }

  let roleSlug = params.get('roleSlug')?.trim() || null;
  if (roleSlug && !ROLE_SLUG_RE.test(roleSlug)) {
    return NextResponse.json({ error: 'invalid roleSlug' }, { status: 400 });
  }
  if (!roleSlug && apiAccount?.taskScope) {
    const task = await db.query.tasks.findFirst({ where: sqlWhere(eq(tasks.id, apiAccount.taskScope.taskId)), columns: { roleSlug: true } });
    roleSlug = task?.roleSlug ?? null;
  }

  const input = await loadDiscoveryInput(workspaceId, roleSlug);
  if (!input) return NextResponse.json({ error: 'workspace_not_found' }, { status: 404 });

  const provider = params.get('provider')?.trim().toLowerCase() || null;
  if (provider) {
    const access = params.get('access') ?? 'read';
    if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(provider) || (access !== 'read' && access !== 'write')) {
      return NextResponse.json({ error: 'invalid_provider', message: 'provider is a catalog slug; access is read or write' }, { status: 400 });
    }
    const result = resolveProviderAccess(input, provider, access);
    await recordResolve(apiAccount, params.get('workerId'), workspaceId, { capability: null, provider, access }, result);
    return NextResponse.json(result);
  }

  const capability = params.get('capability');
  if (!capability) return NextResponse.json(listCapabilities(input));

  const result = resolveCapability(input, capability);
  if ('error' in result) return NextResponse.json({ error: 'unknown_capability', message: result.error }, { status: 400 });
  await recordResolve(apiAccount, params.get('workerId'), workspaceId, { capability, provider: null, access: null }, result);
  return NextResponse.json(result);
}
