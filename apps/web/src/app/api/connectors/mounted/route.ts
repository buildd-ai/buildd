import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { verifyWorkspaceAccess, verifyAccountWorkspaceAccess } from '@/lib/team-access';
import { listMountedConnectors } from '@/lib/connector-queries';

// GET /api/connectors/mounted?workspaceId=<id>
//
// Worker-level connector health for a workspace — unlike
// /api/workspaces/[id]/connectors (admin API-key level only), this is reachable
// by any authenticated worker/API-key account with access to the workspace.
// Backs the list_connectors MCP action across all transports.
export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  const apiAccount = await authenticateApiKey(apiKey);

  if (!user && !apiAccount) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) {
    return NextResponse.json({ error: 'workspaceId is required' }, { status: 400 });
  }

  if (user && !apiAccount) {
    const access = await verifyWorkspaceAccess(user.id, workspaceId);
    if (!access) return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
  } else if (apiAccount) {
    const hasAccess = await verifyAccountWorkspaceAccess(apiAccount.id, workspaceId);
    if (!hasAccess) return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
  }

  const result = await listMountedConnectors(workspaceId);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 404 });
  }
  return NextResponse.json({ connectors: result.connectors });
}
