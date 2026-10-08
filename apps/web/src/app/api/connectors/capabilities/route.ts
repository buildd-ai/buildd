import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { tasks } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateTaskScopedCaller, taskScopeAllowsWorkspace } from '@/lib/task-token-auth';
import { verifyWorkspaceAccess, verifyAccountWorkspaceAccess } from '@/lib/team-access';
import { loadDiscoveryInput } from '@/lib/capability-discovery-store';
import { listCapabilities, resolveCapability } from '@/lib/capability-discovery';

const ROLE_SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

// GET /api/connectors/capabilities?workspaceId=<id>[&capability=observability:query][&roleSlug=builder]
//
// Read-only semantic capability discovery over the workspace's connectors,
// roles, credential health and the team's catalog policy. With `capability`
// it resolves one need to ranked candidates; without, it lists every need
// something serves. Backs the resolve_capability MCP action. Same reach as
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
    const hasAccess = await verifyAccountWorkspaceAccess(apiAccount.id, workspaceId);
    if (!hasAccess) return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
  }

  let roleSlug = params.get('roleSlug')?.trim() || null;
  if (roleSlug && !ROLE_SLUG_RE.test(roleSlug)) {
    return NextResponse.json({ error: 'invalid roleSlug' }, { status: 400 });
  }
  if (!roleSlug && apiAccount?.taskScope) {
    const task = await db.query.tasks.findFirst({ where: eq(tasks.id, apiAccount.taskScope.taskId), columns: { roleSlug: true } });
    roleSlug = task?.roleSlug ?? null;
  }

  const input = await loadDiscoveryInput(workspaceId, roleSlug);
  if (!input) return NextResponse.json({ error: 'workspace_not_found' }, { status: 404 });

  const capability = params.get('capability');
  if (!capability) return NextResponse.json(listCapabilities(input));

  const result = resolveCapability(input, capability);
  if ('error' in result) return NextResponse.json({ error: 'unknown_capability', message: result.error }, { status: 400 });
  return NextResponse.json(result);
}
