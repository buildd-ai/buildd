import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { workspaces } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { verifyWorkspaceAccess } from '@/lib/team-access';
import { getTeamPermissionOverrides, roleHas } from '@/lib/permissions';
import { hasTokenRouteAdminAccess } from '@/lib/token-route-policy';
import { isPaused, resolvePauseUntil, setWorkspacePause } from '@/lib/workspace-pause';

/**
 * GET/POST /api/workspaces/[id]/pause-starts: "Pause new starts until <time>".
 * POST { for: '4h' } | { until: ISO } pauses; { until: null } resumes now.
 * Reading needs workspace access; changing it is manage_workspace_settings
 * (owner/admin, or an admin-level key of the workspace's team).
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the authenticated account row, as the sibling settings route takes it
type Auth = { user: { id: string } | null; apiAccount: any };

async function resolveAuth(req: NextRequest): Promise<Auth | null> {
  const apiKey = req.headers.get('authorization')?.replace('Bearer ', '') || null;
  const apiAccount = await authenticateApiKey(apiKey, req);
  const user = await getCurrentUser();
  if (!apiAccount && !user) return null;
  return { user, apiAccount };
}

async function access(auth: Auth, workspaceId: string, req: NextRequest, write: boolean): Promise<'ok' | 'forbidden' | 'not_found'> {
  if (auth.user && !auth.apiAccount) {
    const a = await verifyWorkspaceAccess(auth.user.id, workspaceId);
    if (!a) return 'not_found';
    if (!write) return 'ok';
    return roleHas(a.role, 'manage_workspace_settings', await getTeamPermissionOverrides(a.teamId)) ? 'ok' : 'forbidden';
  }
  const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId), columns: { teamId: true } });
  if (!ws || ws.teamId !== auth.apiAccount?.teamId) return 'not_found';
  if (!write) return 'ok';
  return hasTokenRouteAdminAccess(auth.apiAccount, req) ? 'ok' : 'forbidden';
}

function view(until: Date | null | undefined, by: string | null | undefined) {
  const paused = isPaused(until ?? null);
  return { paused, until: paused ? new Date(until!).toISOString() : null, by: paused ? by ?? null : null };
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const auth = await resolveAuth(req);
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if ((await access(auth, id, req, false)) !== 'ok') return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
  const ws = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, id),
    columns: { newStartsPausedUntil: true, newStartsPausedBy: true },
  });
  if (!ws) return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
  return NextResponse.json(view(ws.newStartsPausedUntil, ws.newStartsPausedBy));
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const auth = await resolveAuth(req);
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const allowed = await access(auth, id, req, true);
  if (allowed === 'not_found') return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
  if (allowed === 'forbidden') {
    return NextResponse.json({ error: 'Pausing new starts needs permission to manage this workspace\'s settings (owner or admin).' }, { status: 403 });
  }
  const body = await req.json().catch(() => ({}));
  const resolved = resolvePauseUntil(body ?? {});
  if ('error' in resolved) return NextResponse.json({ error: resolved.error }, { status: 400 });
  const by = auth.user && !auth.apiAccount ? auth.user.id : null;
  await setWorkspacePause(id, resolved.until, by);
  return NextResponse.json(view(resolved.until, by));
}
