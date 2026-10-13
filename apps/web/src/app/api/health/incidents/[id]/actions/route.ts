import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { failureIncidents, workspaces } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import type { FailureRecoveryCapability } from '@buildd/shared';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { verifyWorkspaceAccess, verifyAccountWorkspaceAccess } from '@/lib/team-access';
import { hasTokenRouteAdminAccess } from '@/lib/token-route-policy';
import { getViewerTimezone } from '@/lib/team-timezone';
import { applyIncidentCapability, RECOVERY_CAPABILITIES } from './apply';
import { productionIncidentActionDeps } from './deps';
import { sqlWhere } from '@buildd/core/db/relational-sql';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * POST /api/health/incidents/[id]/actions — body `{ capability, generation, evidenceRevision }`
 *
 * The incident page's only write path (failure-incident-recovery §9). The
 * capability is one of the closed set; the caller must reach the incident's
 * workspace (an API key must be admin-level). The facts are re-read before
 * anything is applied: a click made on an older generation, or for an option
 * the fresh assessment no longer offers, answers 409 with the fresh
 * projection. An option done where its subject lives (a PR, a task) answers
 * 422 with the link. 200 returns the projection after the change.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;

    const apiKey = req.headers.get('authorization')?.replace('Bearer ', '') || null;
    const apiAccount = await authenticateApiKey(apiKey, req);
    const user = apiAccount ? null : await getCurrentUser();
    if (!user && !apiAccount) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    if (apiAccount && !hasTokenRouteAdminAccess(apiAccount, req)) {
      return NextResponse.json({ error: 'Acting on an incident requires an admin-level token' }, { status: 403 });
    }
    if (!UUID_RE.test(id)) {
      return NextResponse.json({ error: `incidentId must be a full UUID — received "${id}"` }, { status: 400 });
    }

    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    const capability = body?.capability;
    if (typeof capability !== 'string' || !RECOVERY_CAPABILITIES.has(capability as FailureRecoveryCapability)) {
      return NextResponse.json({ error: `capability must be one of ${[...RECOVERY_CAPABILITIES].join(', ')}` }, { status: 400 });
    }
    const generation = typeof body?.generation === 'number' ? body.generation : null;
    const evidenceRevision = typeof body?.evidenceRevision === 'string' ? body.evidenceRevision : null;

    const row = await db.query.failureIncidents.findFirst({ where: sqlWhere(eq(failureIncidents.id, id)), columns: { id: true, workspaceId: true } });
    const wsId = row?.workspaceId ?? null;
    const hasAccess = row && wsId
      ? apiAccount ? await verifyAccountWorkspaceAccess(apiAccount, wsId) : await verifyWorkspaceAccess(user!.id, wsId)
      : false;
    if (!row || !wsId || !hasAccess) return NextResponse.json({ error: 'Incident not found' }, { status: 404 });

    const ws = await db.query.workspaces.findFirst({ where: sqlWhere(eq(workspaces.id, wsId)), columns: { teamId: true } });
    const teamId = ws?.teamId ?? null;
    const timeZone = await getViewerTimezone(user?.id ?? null, teamId);

    const result = await applyIncidentCapability(
      await productionIncidentActionDeps(teamId),
      id,
      { capability: capability as FailureRecoveryCapability, generation, evidenceRevision },
      { timeZone },
    );
    return NextResponse.json(result.body, { status: result.status });
  } catch (err) {
    console.error('[api/health/incidents/[id]/actions] failed:', err);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
