import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { workspaces } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { authenticateApiKey } from '@/lib/api-auth';
import { getCurrentUser } from '@/lib/auth-helpers';
import { holdsInWorkspace, verifyWorkspaceAccess } from '@/lib/team-access';
import { hasTokenRouteAdminAccess } from '@/lib/token-route-policy';
import { isUuid } from '@/lib/uuid';
import { checkWorkspaceRepoConnection, getRepoAccessView } from '@/lib/github-repo-access-store';

/**
 * /api/workspaces/[id]/github-access
 *
 * GET  — can Buildd's GitHub App act on this workspace's repo, and if not,
 *        what is missing and who can fix it. Any member of the workspace's team.
 * POST — "Check connection": re-read the installation(s) from GitHub, mirror
 *        their repos, link the workspace if its repo is now covered, and resume
 *        tasks that failed waiting on this access once it is verified. The
 *        fallback for a webhook that never arrived. Requires
 *        manage_workspace_settings (or an admin-level key of the same team):
 *        it rewrites the workspace's repo link and re-queues tasks.
 *
 * Neither changes anything on GitHub, and neither creates a repository.
 */

async function authorize(
  req: NextRequest,
  id: string,
  needManage: boolean,
): Promise<{ userId: string | null } | NextResponse> {
  if (!isUuid(id)) return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });

  const apiKey = req.headers.get('authorization')?.replace('Bearer ', '') || null;
  const apiAccount = apiKey ? await authenticateApiKey(apiKey, req) : null;
  if (apiAccount) {
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, id), columns: { teamId: true } });
    if (!ws || ws.teamId !== apiAccount.teamId) return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
    if (needManage && !hasTokenRouteAdminAccess(apiAccount, req)) {
      return NextResponse.json({ error: 'Requires admin-level API key' }, { status: 403 });
    }
    return { userId: null };
  }

  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!(await verifyWorkspaceAccess(user.id, id))) return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
  if (needManage && !(await holdsInWorkspace(user.id, id, 'manage_workspace_settings'))) {
    return NextResponse.json({ error: 'Only workspace admins can check the GitHub connection' }, { status: 403 });
  }
  return { userId: user.id };
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const auth = await authorize(req, id, false);
  if (auth instanceof NextResponse) return auth;
  try {
    return NextResponse.json(await getRepoAccessView(id, auth.userId));
  } catch (error) {
    console.error('[github-access] GET failed:', error);
    return NextResponse.json({ error: 'Could not read the GitHub connection' }, { status: 500 });
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const auth = await authorize(req, id, true);
  if (auth instanceof NextResponse) return auth;
  try {
    const result = await checkWorkspaceRepoConnection(id);
    const view = await getRepoAccessView(id, auth.userId);
    return NextResponse.json({
      verified: result.verified,
      linked: result.healed,
      resumed: result.resumed.length,
      refreshedInstallations: result.refreshedInstallations,
      view,
    });
  } catch (error) {
    console.error('[github-access] check connection failed:', error);
    return NextResponse.json({ error: 'Could not check the GitHub connection' }, { status: 500 });
  }
}
