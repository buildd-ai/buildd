import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth-helpers';
import { verifyWorkspaceAccess } from '@/lib/team-access';
import {
  storeClaudeCredential,
  getClaudeStatus,
  deleteClaudeCredential,
  normalizeClaudeCredentialsJson,
  type ClaudeScope,
} from '@/lib/claude-credential';
import { requeueAuthFailedTasks } from '@/lib/credential-recovery';

type RouteContext = { params: Promise<{ id: string }> };

function buildScope(teamId: string, workspaceId: string, scopeParam: string | null): ClaudeScope {
  return scopeParam === 'workspace'
    ? { teamId, workspaceId }
    : { teamId };
}

// GET /api/workspaces/[id]/claude-credential?scope=team|workspace — status (no tokens)
export async function GET(req: NextRequest, { params }: RouteContext) {
  const { id } = await params;
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const access = await verifyWorkspaceAccess(user.id, id);
  if (!access) return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
  const scope = buildScope(access.teamId, id, req.nextUrl.searchParams.get('scope'));
  const status = await getClaudeStatus(scope);
  return NextResponse.json(status);
}

// POST /api/workspaces/[id]/claude-credential — store ~/.claude/.credentials.json content
// Body: { credentialsJson: string, scope?: 'team' | 'workspace' } (default 'team')
export async function POST(req: NextRequest, { params }: RouteContext) {
  const { id } = await params;
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const access = await verifyWorkspaceAccess(user.id, id);
  if (!access) return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });

  const body = await req.json();
  if (!body.credentialsJson || typeof body.credentialsJson !== 'string') {
    return NextResponse.json({ error: 'credentialsJson is required' }, { status: 400 });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body.credentialsJson);
  } catch {
    return NextResponse.json({ error: 'credentialsJson must be valid JSON' }, { status: 400 });
  }

  const normalized = normalizeClaudeCredentialsJson(parsed);
  if (!normalized.ok) {
    return NextResponse.json({ error: normalized.error }, { status: 400 });
  }

  const scope = buildScope(access.teamId, id, typeof body.scope === 'string' ? body.scope : null);
  await storeClaudeCredential(scope, normalized.value);
  // Recover tasks that failed on the old (revoked/expired) credential. Best-effort.
  try {
    await requeueAuthFailedTasks(access.teamId);
  } catch (err) {
    console.warn('[claude-credential] requeue-on-recovery failed (non-fatal):', err);
  }
  const status = await getClaudeStatus(scope);
  return NextResponse.json(status);
}

// DELETE /api/workspaces/[id]/claude-credential?scope=team|workspace — remove credential
export async function DELETE(req: NextRequest, { params }: RouteContext) {
  const { id } = await params;
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const access = await verifyWorkspaceAccess(user.id, id);
  if (!access) return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
  const scope = buildScope(access.teamId, id, req.nextUrl.searchParams.get('scope'));
  await deleteClaudeCredential(scope);
  return new NextResponse(null, { status: 204 });
}
