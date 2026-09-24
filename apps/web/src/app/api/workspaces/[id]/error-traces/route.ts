import { NextRequest, NextResponse } from 'next/server';
import { authenticateApiKey } from '@/lib/api-auth';
import { getCurrentUser } from '@/lib/auth-helpers';
import { verifyWorkspaceAccess, verifyAccountWorkspaceAccess } from '@/lib/team-access';
import { getWorkspaceErrorTraceRollup, parseRollupParams } from '@/lib/workspace-error-traces';
import type { WorkspaceErrorTracesResponse } from '@buildd/shared';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// GET /api/workspaces/[id]/error-traces?since=<ISO>&limit=<n>
//
// Which error-trace patterns recur across this workspace: per pattern, the
// count, distinct task count, first/last seen, the latest excerpt and a few
// example task ids. `since` defaults to 7 days ago; `limit` (patterns) to 20,
// max 100. Backs `get_error_traces` with a workspaceId scope, so a session
// without a worker context can still tell a new failure from a recurring one.
//
// Access follows /api/tasks/[id]/error-traces: team membership for a session
// user, workspace access for an API account, and 404 (not 403) otherwise so
// the route does not confirm a workspace exists.
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const user = await getCurrentUser();
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  const apiAccount = await authenticateApiKey(apiKey);

  if (!user && !apiAccount) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: 'workspace id must be a UUID' }, { status: 400 });
  }

  const allowed = apiAccount && !user
    ? await verifyAccountWorkspaceAccess(apiAccount.id, id)
    : !!(await verifyWorkspaceAccess(user!.id, id));
  if (!allowed) {
    return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
  }

  const { since, limit } = parseRollupParams(req.nextUrl.searchParams);
  const patterns = await getWorkspaceErrorTraceRollup({ workspaceId: id, since, limit });

  const body: WorkspaceErrorTracesResponse = {
    workspaceId: id,
    since: since.toISOString(),
    limit,
    patterns,
  };
  return NextResponse.json(body);
}
