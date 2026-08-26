import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { workspaceSkills, connectors } from '@buildd/core/db/schema';
import { eq, and, or, isNull, inArray } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { verifyWorkspaceAccess } from '@/lib/team-access';
import { checkConnectorRouting } from '@/lib/claim-gates';

export type ConnectorHealthStatus = 'ok' | 'auth_expired' | 'server_unreachable' | 'not_configured';

export interface ConnectorHealthEntry {
  connectorId: string;
  connectorName: string;
  status: ConnectorHealthStatus;
}

function modeToStatus(mode: string): ConnectorHealthStatus {
  if (mode === 'never_mounted') return 'not_configured';
  if (mode === 'expired_or_revoked') return 'auth_expired';
  if (mode === 'transient') return 'server_unreachable';
  return 'not_configured';
}

// GET /api/workspaces/[id]/connector-health?roleSlug=<slug>
// Returns live health status for each connectorRef on the role.
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: workspaceId } = await params;

  if (process.env.NODE_ENV === 'development') {
    return NextResponse.json({ connectors: [] });
  }

  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const access = await verifyWorkspaceAccess(user.id, workspaceId);
  if (!access) return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });

  const roleSlug = req.nextUrl.searchParams.get('roleSlug');
  if (!roleSlug) return NextResponse.json({ error: 'roleSlug required' }, { status: 400 });

  const { teamId } = access;

  try {
    // Get the role's connectorRefs and connector names
    const roleRows = await db.query.workspaceSkills.findMany({
      where: and(
        eq(workspaceSkills.slug, roleSlug),
        eq(workspaceSkills.isRole, true),
        eq(workspaceSkills.teamId, teamId),
        or(
          isNull(workspaceSkills.workspaceId),
          eq(workspaceSkills.workspaceId, workspaceId),
        ),
      ),
      columns: { workspaceId: true, connectorRefs: true },
    });

    const roleRow =
      roleRows.find(r => r.workspaceId === workspaceId) ?? roleRows[0];

    if (!roleRow) {
      return NextResponse.json({ connectors: [] });
    }

    const refs = (roleRow.connectorRefs as string[] | null) ?? [];
    if (refs.length === 0) {
      return NextResponse.json({ connectors: [] });
    }

    // Resolve connector names for all refs
    const connectorRows = await db.query.connectors.findMany({
      where: inArray(connectors.id, refs),
      columns: { id: true, name: true },
    });
    const nameById = new Map(connectorRows.map(c => [c.id, c.name]));

    // Run live health check (same logic as claim route)
    const failures = await checkConnectorRouting(roleSlug, workspaceId, teamId);
    const failureByConnectorId = new Map(
      (failures ?? []).map(f => [f.connectorId, f.mode]),
    );

    const result: ConnectorHealthEntry[] = refs.map(refId => {
      const name = nameById.get(refId) ?? refId;
      const failMode = failureByConnectorId.get(refId);
      return {
        connectorId: refId,
        connectorName: name,
        status: failMode ? modeToStatus(failMode) : 'ok',
      };
    });

    return NextResponse.json({ connectors: result });
  } catch (error) {
    console.error('[connector-health] Error:', error);
    return NextResponse.json({ error: 'Health check failed' }, { status: 500 });
  }
}
