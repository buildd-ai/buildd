import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth-helpers';
import { verifyWorkspaceAccess } from '@/lib/team-access';
import {
  storeCodexCredential,
  getCodexStatus,
  deleteCodexCredential,
  normalizeCodexAuthJson,
  type CodexScope,
} from '@/lib/codex-credential';
import { requeueAuthFailedTasks } from '@/lib/credential-recovery';

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Build the credential scope from the request. Default is team-wide (shared by
 * every workspace in the team); `scope=workspace` narrows it to this workspace.
 * See docs/credentials-architecture.md.
 */
function buildScope(teamId: string, workspaceId: string, scopeParam: string | null): CodexScope {
  return scopeParam === 'workspace'
    ? { teamId, workspaceId }
    : { teamId };
}

// GET /api/workspaces/[id]/codex-credential?scope=team|workspace — status (no tokens)
export async function GET(req: NextRequest, { params }: RouteContext) {
  const { id } = await params;

  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const access = await verifyWorkspaceAccess(user.id, id);
  if (!access) return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });

  const scope = buildScope(access.teamId, id, req.nextUrl.searchParams.get('scope'));
  const status = await getCodexStatus(scope);
  return NextResponse.json(status);
}

// POST /api/workspaces/[id]/codex-credential — store encrypted Codex auth.json
// Body: { authJson: string, scope?: 'team' | 'workspace' } (default 'team')
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

  // Accept the raw ~/.codex/auth.json (fields nested under `tokens`) or a flat object.
  const normalized = normalizeCodexAuthJson(parsed);
  if (!normalized.ok) {
    return NextResponse.json({ error: normalized.error }, { status: 400 });
  }

  const scope = buildScope(access.teamId, id, typeof body.scope === 'string' ? body.scope : null);
  await storeCodexCredential(scope, normalized.value);
  // Recover Codex tasks that failed on the old (revoked/expired) credential. Best-effort.
  try {
    await requeueAuthFailedTasks(access.teamId);
  } catch (err) {
    console.warn('[codex-credential] requeue-on-recovery failed (non-fatal):', err);
  }
  const status = await getCodexStatus(scope);
  return NextResponse.json(status);
}

// DELETE /api/workspaces/[id]/codex-credential?scope=team|workspace — remove credential
export async function DELETE(req: NextRequest, { params }: RouteContext) {
  const { id } = await params;

  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const access = await verifyWorkspaceAccess(user.id, id);
  if (!access) return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });

  const scope = buildScope(access.teamId, id, req.nextUrl.searchParams.get('scope'));
  await deleteCodexCredential(scope);
  return new NextResponse(null, { status: 204 });
}
