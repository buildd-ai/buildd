import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth-helpers';
import { verifyWorkspaceAccess } from '@/lib/team-access';
import { refreshCodexCredential } from '@/lib/codex-credential';

type RouteContext = { params: Promise<{ id: string }> };

// POST /api/workspaces/[id]/codex-credential/refresh — trigger a token refresh
export async function POST(_req: NextRequest, { params }: RouteContext) {
  const { id } = await params;

  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const access = await verifyWorkspaceAccess(user.id, id);
  if (!access) return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });

  const status = await refreshCodexCredential(id);
  return NextResponse.json({ status });
}
