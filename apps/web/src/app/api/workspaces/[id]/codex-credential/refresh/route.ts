import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth-helpers';
import { verifyWorkspaceAccess } from '@/lib/team-access';
import { refreshCodexCredential, getCodexSecretId, type CodexScope } from '@/lib/codex-credential';

type RouteContext = { params: Promise<{ id: string }> };

// POST /api/workspaces/[id]/codex-credential/refresh?scope=team|workspace — trigger a token refresh
export async function POST(req: NextRequest, { params }: RouteContext) {
  const { id } = await params;

  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const access = await verifyWorkspaceAccess(user.id, id);
  if (!access) return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });

  const scope: CodexScope = req.nextUrl.searchParams.get('scope') === 'workspace'
    ? { teamId: access.teamId, workspaceId: id }
    : { teamId: access.teamId };

  const secretId = await getCodexSecretId(scope);
  if (!secretId) return NextResponse.json({ status: 'no_credential' });

  const status = await refreshCodexCredential(secretId);
  return NextResponse.json({ status });
}
