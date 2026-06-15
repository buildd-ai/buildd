import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth-helpers';
import { verifyWorkspaceAccess } from '@/lib/team-access';
import {
  storeCodexCredential,
  getCodexStatus,
  deleteCodexCredential,
  type CodexAuthJson,
} from '@/lib/codex-credential';

type RouteContext = { params: Promise<{ id: string }> };

// GET /api/workspaces/[id]/codex-credential — return connection status (no tokens)
export async function GET(_req: NextRequest, { params }: RouteContext) {
  const { id } = await params;

  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const access = await verifyWorkspaceAccess(user.id, id);
  if (!access) return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });

  const status = await getCodexStatus(id);
  return NextResponse.json(status);
}

// POST /api/workspaces/[id]/codex-credential — store encrypted Codex auth.json
export async function POST(req: NextRequest, { params }: RouteContext) {
  const { id } = await params;

  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const access = await verifyWorkspaceAccess(user.id, id);
  if (!access) return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });

  const body = await req.json();
  if (!body.authJson || typeof body.authJson !== 'string') {
    return NextResponse.json({ error: 'authJson is required' }, { status: 400 });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body.authJson);
  } catch {
    return NextResponse.json({ error: 'authJson must be valid JSON' }, { status: 400 });
  }

  const auth = parsed as Record<string, unknown>;
  if (
    typeof auth.access_token !== 'string' ||
    typeof auth.refresh_token !== 'string' ||
    typeof auth.account_id !== 'string' ||
    (auth.expires_in == null && auth.expiry == null)
  ) {
    return NextResponse.json(
      { error: 'authJson must contain access_token, refresh_token, account_id, and expires_in or expiry' },
      { status: 400 },
    );
  }

  await storeCodexCredential(id, auth as unknown as CodexAuthJson);
  const status = await getCodexStatus(id);
  return NextResponse.json(status);
}

// DELETE /api/workspaces/[id]/codex-credential — remove stored credential
export async function DELETE(_req: NextRequest, { params }: RouteContext) {
  const { id } = await params;

  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const access = await verifyWorkspaceAccess(user.id, id);
  if (!access) return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });

  await deleteCodexCredential(id);
  return new NextResponse(null, { status: 204 });
}
