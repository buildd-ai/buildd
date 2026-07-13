import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { connectors, connectorShares, connectorWorkspaces, workspaces, secrets } from '@buildd/core/db/schema';
import { eq, and, inArray } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { verifyWorkspaceAccess, verifyAccountWorkspaceAccess } from '@/lib/team-access';

async function authenticateRequest(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;

  if (apiKey) {
    const account = await authenticateApiKey(apiKey);
    if (account) {
      if (account.level !== 'admin') return { type: 'denied' as const };
      return { type: 'api' as const, account };
    }
  }

  if (process.env.NODE_ENV !== 'development') {
    const user = await getCurrentUser();
    if (user) return { type: 'session' as const, user };
  } else {
    return { type: 'dev' as const };
  }

  return null;
}

function deriveStatus(secret: { tokenExpiresAt: Date | null } | undefined): 'connected' | 'expired' | 'not_connected' {
  if (!secret) return 'not_connected';
  if (secret.tokenExpiresAt && secret.tokenExpiresAt < new Date()) return 'expired';
  return 'connected';
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: workspaceId } = await params;
  const auth = await authenticateRequest(req);
  if (!auth || auth.type === 'denied') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (auth.type === 'dev') {
    return NextResponse.json({ connectors: [] });
  }

  // Verify workspace access
  let teamId: string;
  if (auth.type === 'api') {
    const ok = await verifyAccountWorkspaceAccess(auth.account.id, workspaceId);
    if (!ok) return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
    teamId = auth.account.teamId;
  } else {
    const access = await verifyWorkspaceAccess(auth.user.id, workspaceId);
    if (!access) return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
    teamId = access.teamId;
  }

  try {
    const rows = await db.query.connectorWorkspaces.findMany({
      where: and(
        eq(connectorWorkspaces.workspaceId, workspaceId),
        eq(connectorWorkspaces.enabled, true),
      ),
      with: { connector: true },
    });

    // Batch load secrets for status. Keyed on each connector's OWNER team
    // (spec §1b): a shared-in connector's credential lives on the owner team,
    // not this workspace's team.
    const connectorIds = rows.map(r => r.connectorId);
    let secretMap = new Map<string, { tokenExpiresAt: Date | null }>();
    if (connectorIds.length > 0) {
      const ownerTeamIds = [...new Set(rows.map(r => r.connector?.teamId).filter(Boolean))] as string[];
      const secretRows = await db.query.secrets.findMany({
        where: and(
          inArray(secrets.teamId, ownerTeamIds.length > 0 ? ownerTeamIds : [teamId]),
          eq(secrets.purpose, 'mcp_connector_credential'),
        ),
        columns: { label: true, tokenExpiresAt: true },
      });
      for (const s of secretRows) {
        if (s.label && connectorIds.includes(s.label)) {
          secretMap.set(s.label, { tokenExpiresAt: s.tokenExpiresAt });
        }
      }
    }

    const result = rows
      .filter(r => r.connector)
      .map(r => ({
        id: r.connector.id,
        name: r.connector.name,
        url: r.connector.url,
        authMode: r.connector.authMode,
        enabled: r.enabled,
        status: deriveStatus(secretMap.get(r.connectorId)),
      }));

    return NextResponse.json({ connectors: result });
  } catch (error) {
    console.error('List workspace connectors error:', error);
    return NextResponse.json({ error: 'Failed to list connectors' }, { status: 500 });
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: workspaceId } = await params;
  const auth = await authenticateRequest(req);
  if (!auth || auth.type === 'denied') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (auth.type === 'dev') {
    return NextResponse.json({ success: true });
  }

  // Verify workspace access
  let teamId: string;
  if (auth.type === 'api') {
    const ok = await verifyAccountWorkspaceAccess(auth.account.id, workspaceId);
    if (!ok) return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
    teamId = auth.account.teamId;
  } else {
    const access = await verifyWorkspaceAccess(auth.user.id, workspaceId);
    if (!access) return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
    teamId = access.teamId;
  }

  let body: { connectorId: string; enabled: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { connectorId, enabled } = body;
  if (!connectorId || typeof enabled !== 'boolean') {
    return NextResponse.json({ error: 'connectorId and enabled are required' }, { status: 400 });
  }

  // Visibility check (spec §1b AC-2): a workspace may enable a connector its
  // team OWNS, or one SHARED to its team via connector_shares. Anything else
  // is not visible → 404.
  const connector = await db.query.connectors.findFirst({
    where: eq(connectors.id, connectorId),
    columns: { id: true, teamId: true },
  });
  let visible = !!connector && connector.teamId === teamId;
  if (connector && !visible) {
    const share = await db.query.connectorShares.findFirst({
      where: and(
        eq(connectorShares.connectorId, connectorId),
        eq(connectorShares.sharedWithTeamId, teamId),
      ),
    });
    visible = !!share;
  }
  if (!visible) {
    return NextResponse.json({ error: 'Connector not found' }, { status: 404 });
  }

  try {
    await db.insert(connectorWorkspaces)
      .values({ connectorId, workspaceId, enabled })
      .onConflictDoUpdate({
        target: [connectorWorkspaces.connectorId, connectorWorkspaces.workspaceId],
        set: { enabled },
      });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Toggle workspace connector error:', error);
    return NextResponse.json({ error: 'Failed to update connector' }, { status: 500 });
  }
}
