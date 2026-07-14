import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { workspaces, connectors, connectorWorkspaces, type WorkspaceWorkTrackerConfig } from '@buildd/core/db/schema';
import { eq, and } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { verifyWorkspaceAccess } from '@/lib/team-access';

async function resolveAuth(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  const apiAccount = await authenticateApiKey(apiKey);
  const user = await getCurrentUser();
  if (!apiAccount && !user) return null;
  return { user, apiAccount };
}

async function verifyAccess(auth: { user: any; apiAccount: any }, workspaceId: string): Promise<boolean> {
  const { user, apiAccount } = auth;
  if (user && !apiAccount) {
    const access = await verifyWorkspaceAccess(user.id, workspaceId);
    return Boolean(access);
  }
  if (apiAccount) {
    const ws = await db.query.workspaces.findFirst({
      where: eq(workspaces.id, workspaceId),
      columns: { teamId: true, accessMode: true },
    });
    return Boolean(ws && (ws.teamId === apiAccount.teamId || ws.accessMode === 'open'));
  }
  return false;
}

// GET /api/workspaces/[id]/settings — retrieve workTrackerConfig
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const auth = await resolveAuth(req);
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const hasAccess = await verifyAccess(auth, id);
  if (!hasAccess) {
    return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
  }

  try {
    const workspace = await db.query.workspaces.findFirst({
      where: eq(workspaces.id, id),
      columns: { workTrackerConfig: true },
    });

    if (!workspace) {
      return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
    }

    return NextResponse.json({ workTrackerConfig: workspace.workTrackerConfig ?? null });
  } catch (error) {
    console.error('GET workspace settings error:', error);
    return NextResponse.json({ error: 'Failed to fetch settings' }, { status: 500 });
  }
}

// PATCH /api/workspaces/[id]/settings — update workTrackerConfig
// Body: { workTrackerConfig: { connectorId: string, provider: string } | null }
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const auth = await resolveAuth(req);
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const hasAccess = await verifyAccess(auth, id);
  if (!hasAccess) {
    return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'Request body must be an object' }, { status: 400 });
  }

  const b = body as Record<string, unknown>;
  if (!('workTrackerConfig' in b)) {
    return NextResponse.json({ error: 'Body must contain workTrackerConfig' }, { status: 400 });
  }

  const wtc = b.workTrackerConfig;

  // null clears the work tracker
  if (wtc === null) {
    await db.update(workspaces)
      .set({ workTrackerConfig: null, updatedAt: new Date() })
      .where(eq(workspaces.id, id));
    return NextResponse.json({ success: true, workTrackerConfig: null });
  }

  if (typeof wtc !== 'object' || !wtc) {
    return NextResponse.json({ error: 'workTrackerConfig must be an object or null' }, { status: 400 });
  }

  const wtcObj = wtc as Record<string, unknown>;
  const provider = wtcObj.provider;
  if (provider !== 'linear' && provider !== 'github') {
    return NextResponse.json({ error: 'unsupported_provider' }, { status: 400 });
  }

  const ws = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, id),
    columns: { teamId: true, githubInstallationId: true },
  });
  if (!ws) {
    return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
  }

  let config: WorkspaceWorkTrackerConfig;

  if (provider === 'github') {
    // GitHub uses the workspace's existing App installation — no connector.
    if (!ws.githubInstallationId) {
      return NextResponse.json({ error: 'github_app_not_installed' }, { status: 400 });
    }
    // Optional inbound trigger label (defaults applied at webhook time when unset).
    const inboundLabel = typeof wtcObj.inboundLabel === 'string' && wtcObj.inboundLabel.trim()
      ? wtcObj.inboundLabel.trim()
      : undefined;
    config = { provider: 'github', ...(inboundLabel ? { inboundLabel } : {}) };
  } else {
    // Linear requires a connector enabled for this workspace.
    if (typeof wtcObj.connectorId !== 'string' || !wtcObj.connectorId) {
      return NextResponse.json({ error: 'workTrackerConfig.connectorId is required' }, { status: 400 });
    }
    const connectorId = wtcObj.connectorId;

    const connectorRow = await db.query.connectors.findFirst({
      where: and(eq(connectors.id, connectorId), eq(connectors.teamId, ws.teamId)),
      columns: { id: true },
    });
    if (!connectorRow) {
      return NextResponse.json({ error: 'Connector not found or does not belong to this team' }, { status: 403 });
    }

    const linked = await db.query.connectorWorkspaces.findFirst({
      where: and(
        eq(connectorWorkspaces.connectorId, connectorId),
        eq(connectorWorkspaces.workspaceId, id),
        eq(connectorWorkspaces.enabled, true),
      ),
      columns: { connectorId: true },
    });
    if (!linked) {
      return NextResponse.json({ error: 'Connector is not enabled for this workspace' }, { status: 422 });
    }

    config = { provider: 'linear', connectorId };
  }

  try {
    await db.update(workspaces)
      .set({ workTrackerConfig: config, updatedAt: new Date() })
      .where(eq(workspaces.id, id));
    return NextResponse.json({ success: true, workTrackerConfig: config });
  } catch (error) {
    console.error('PATCH workspace settings error:', error);
    return NextResponse.json({ error: 'Failed to save settings' }, { status: 500 });
  }
}
