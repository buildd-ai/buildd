import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth-helpers';
import { verifyWorkspaceAccess } from '@/lib/team-access';
import { startClaudeOAuthLogin } from '@/lib/claude-oauth-login';

type RouteContext = { params: Promise<{ id: string }> };

// POST /api/workspaces/[id]/claude-credential/oauth/start
// Begin the Claude OAuth connect flow. Returns the authorize URL + PKCE material;
// the client opens the URL, the user approves and pastes back the code to .../oauth/exchange.
export async function POST(_req: NextRequest, { params }: RouteContext) {
  const { id } = await params;

  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const access = await verifyWorkspaceAccess(user.id, id);
  if (!access) return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });

  // verifier/state are single-use, short-lived PKCE material the client echoes back.
  return NextResponse.json(startClaudeOAuthLogin());
}
