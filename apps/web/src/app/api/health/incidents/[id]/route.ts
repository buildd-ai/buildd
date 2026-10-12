import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { failureIncidents } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { isPlatformOperator } from '@/lib/platform-operator';
import { authenticateApiKey } from '@/lib/api-auth';
import { verifyWorkspaceAccess, verifyAccountWorkspaceAccess } from '@/lib/team-access';
import { hasTokenRouteAdminAccess } from '@/lib/token-route-policy';
import { createDbIncidentPort, updateIncidentState } from '@/lib/failure-incident-store';
import { sqlWhere } from '@buildd/core/db/relational-sql';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTIONS = ['acknowledge', 'resolve'] as const;

/**
 * POST /api/health/incidents/[id]  — body `{ action: 'acknowledge' | 'resolve' }`
 *
 * The write side of the Failure Pattern Sentinel's ledger: moves one incident
 * through `updateIncidentState` (the same CAS the paging layer uses), so the
 * `failure_incidents` row is the record — `acknowledgedAt` / `resolvedAt` stamp
 * it. An API key must be admin-level; the incident's workspace must be in the
 * caller's team. Resolving a still-live pattern is not final: the next sweep
 * that sees it again reopens the incident (the store's recurrence path).
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;

    const apiKey = req.headers.get('authorization')?.replace('Bearer ', '') || null;
    const apiAccount = await authenticateApiKey(apiKey, req);
    const user = apiAccount ? null : await getCurrentUser();
    if (!user && !apiAccount) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    if (user && !isPlatformOperator(user)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    if (apiAccount && !hasTokenRouteAdminAccess(apiAccount, req)) {
      return NextResponse.json({ error: 'Changing an incident requires an admin-level token' }, { status: 403 });
    }

    if (!UUID_RE.test(id)) {
      return NextResponse.json({ error: `incidentId must be a full UUID — received "${id}"` }, { status: 400 });
    }
    const body = await req.json().catch(() => null);
    const action = body && typeof body === 'object' ? (body as { action?: unknown }).action : undefined;
    if (typeof action !== 'string' || !(ACTIONS as readonly string[]).includes(action)) {
      return NextResponse.json({ error: `action must be one of ${ACTIONS.join(', ')}` }, { status: 400 });
    }

    const row = await db.query.failureIncidents.findFirst({
      where: sqlWhere(eq(failureIncidents.id, id)),
      columns: { id: true, workspaceId: true },
    });
    const wsId = row?.workspaceId ?? null;
    const hasAccess = row && wsId
      ? apiAccount
        ? await verifyAccountWorkspaceAccess(apiAccount, wsId)
        : await verifyWorkspaceAccess(user!.id, wsId)
      : false;
    if (!row || !hasAccess) return NextResponse.json({ error: 'Incident not found' }, { status: 404 });

    const updated = await updateIncidentState(await createDbIncidentPort(), id, { type: action as (typeof ACTIONS)[number] });
    if (!updated) return NextResponse.json({ error: 'Incident not found' }, { status: 404 });
    return NextResponse.json({ incident: updated });
  } catch (err) {
    console.error('[api/health/incidents/[id]] failed:', err);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
