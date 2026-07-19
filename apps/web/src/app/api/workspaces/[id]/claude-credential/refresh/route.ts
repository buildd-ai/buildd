import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth-helpers';
import { verifyWorkspaceAccess } from '@/lib/team-access';
import { getClaudeSecretId, refreshClaudeCredential } from '@/lib/claude-credential';

type RouteContext = { params: Promise<{ id: string }> };

// POST /api/workspaces/[id]/claude-credential/refresh?scope=team|workspace
export async function POST(req: NextRequest, { params }: RouteContext) {
  const { id } = await params;
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const access = await verifyWorkspaceAccess(user.id, id);
  if (!access) return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });

  const scopeParam = req.nextUrl.searchParams.get('scope');
  const scope = scopeParam === 'workspace'
    ? { teamId: access.teamId, workspaceId: id }
    : { teamId: access.teamId };

  const secretId = await getClaudeSecretId(scope);
  if (!secretId) return NextResponse.json({ status: 'no_credential' });

  const result = await refreshClaudeCredential(secretId);
  return NextResponse.json({ status: result });
}
