/**
 * GET /api/connectors/[id]/tools: the connector's tools as the gateway
 * classes them (read / write / admin / denied) and where each class came
 * from (provider annotation, catalog-vetted, admin override, tool name, or
 * not annotated). For Settings › Team › Apps; a signed-in team member reads
 * it, and `canManage` says whether this person may change the admin's marks
 * (PATCH /api/connectors/[id] with `toolPolicy`, session only).
 *
 * The tools come from the last `tools/list` the gateway saw, the admin's
 * lists, the catalog's vetted reads and tools refused recently for want of a
 * read-only mark (lib/connector-tool-review.ts). Reads only.
 */
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { connectors } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { getUserTeamIds } from '@/lib/team-access';
import { canManageTeamConnectors } from '@/lib/connector-team-auth';
import { connectorToolRows, readToolSnapshot } from '@/lib/connector-tool-review';
import { recentUnvettedTools } from '@/lib/connector-tool-review-store';
import { providerSlugFor } from '@/lib/connector-gateway-store';
import { isUuid } from '@/lib/uuid';
import { sqlWhere } from '@buildd/core/db/relational-sql';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: 'Connector not found' }, { status: 404 });
  // A person's view: an agent's key reads its tools through the gateway, not here.
  if (req.headers.get('authorization')) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const connector = await db.query.connectors.findFirst({ where: sqlWhere(eq(connectors.id, id)) });
  const teamIds = connector ? await getUserTeamIds(user.id) : [];
  if (!connector || !teamIds.includes(connector.teamId)) return NextResponse.json({ error: 'Connector not found' }, { status: 404 });

  // The same slug the gateway resolves, so the catalog's vetted reads match what it enforces.
  const [provider, refused, canManage] = await Promise.all([
    providerSlugFor(connector.teamId, connector.url).catch(() => null),
    recentUnvettedTools(connector.id).catch(() => [] as string[]),
    canManageTeamConnectors(user.id, connector.teamId),
  ]);
  return NextResponse.json({
    canManage,
    snapshotAt: readToolSnapshot(connector.discoveredMetadata)?.at || null,
    tools: connectorToolRows(connector.discoveredMetadata, provider, refused),
  }, { headers: { 'Cache-Control': 'no-store' } });
}

