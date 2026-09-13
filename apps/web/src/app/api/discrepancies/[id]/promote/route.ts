import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { specDiscrepancies, missions } from '@buildd/core/db/schema';
import { and, eq, isNull } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { verifyWorkspaceAccess, verifyAccountWorkspaceAccess } from '@/lib/team-access';
import { assertPromotable } from '@buildd/core/spec-discrepancy-ledger';

// POST /api/discrepancies/[id]/promote — §13 promote_discrepancy backing route.
//
// Mission creation itself happens through the same primitive every other
// mission-creating caller uses (POST /api/missions, called via `api()` from
// the `promote_discrepancy` MCP action in mcp-tools.ts — mirroring how
// `manage_missions` action=create is itself just that same call). This route
// is the authoritative half: it takes the already-created mission's id and
// performs the §8-gated, race-safe write of `promoted_mission_id` back onto
// the row. The gate lives here — not only in the MCP tool's pre-check — so it
// cannot be bypassed by a caller that talks to this route directly.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const user = await getCurrentUser();
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  const apiAccount = await authenticateApiKey(apiKey);

  if (!user && !apiAccount) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (apiAccount && apiAccount.level !== 'admin') {
    return NextResponse.json({ error: 'Requires admin-level API key' }, { status: 403 });
  }

  const row = await db.query.specDiscrepancies.findFirst({ where: eq(specDiscrepancies.id, id) });
  if (!row) return NextResponse.json({ error: 'Discrepancy not found' }, { status: 404 });

  if (user && !apiAccount) {
    const access = await verifyWorkspaceAccess(user.id, row.workspaceId);
    if (!access) return NextResponse.json({ error: 'Discrepancy not found' }, { status: 404 });
  } else if (apiAccount) {
    const hasAccess = await verifyAccountWorkspaceAccess(apiAccount.id, row.workspaceId);
    if (!hasAccess) return NextResponse.json({ error: 'Discrepancy not found' }, { status: 404 });
  }

  // Idempotent: a row already carrying a promoted mission just reports it back
  // rather than erroring — a retried call (e.g. a dropped response after the
  // write succeeded) must not look like a failure.
  if (row.promotedMissionId) {
    return NextResponse.json({ discrepancy: row, missionId: row.promotedMissionId, alreadyPromoted: true });
  }

  let body: { missionId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (!body.missionId) {
    return NextResponse.json({ error: 'missionId is required (create it via manage_missions/POST /api/missions first)' }, { status: 400 });
  }

  try {
    assertPromotable(row.direction);
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  const mission = await db.query.missions.findFirst({
    where: eq(missions.id, body.missionId),
    columns: { id: true, workspaceId: true },
  });
  if (!mission) return NextResponse.json({ error: `Mission not found: ${body.missionId}` }, { status: 404 });
  if (mission.workspaceId !== row.workspaceId) {
    return NextResponse.json({ error: 'Mission belongs to a different workspace than this discrepancy' }, { status: 400 });
  }

  // Atomic UPDATE...WHERE (CLAUDE.md: no db.transaction() on neon-http — use a
  // conditional UPDATE for optimistic locking). Re-checks both preconditions
  // at write time: still unpromoted, still `spec_ahead` — closing the race
  // window between the reads above and this write.
  const [updated] = await db
    .update(specDiscrepancies)
    .set({ promotedMissionId: mission.id })
    .where(and(eq(specDiscrepancies.id, id), isNull(specDiscrepancies.promotedMissionId), eq(specDiscrepancies.direction, 'spec_ahead')))
    .returning();

  if (!updated) {
    const fresh = await db.query.specDiscrepancies.findFirst({ where: eq(specDiscrepancies.id, id) });
    if (fresh?.promotedMissionId) {
      return NextResponse.json({ discrepancy: fresh, missionId: fresh.promotedMissionId, alreadyPromoted: true });
    }
    return NextResponse.json(
      {
        error:
          `Discrepancy direction changed to '${fresh?.direction}' before the link could be written — ` +
          `mission ${mission.id} was created but not linked. Re-check the row before retrying.`,
        discrepancy: fresh ?? null,
      },
      { status: 409 }
    );
  }

  return NextResponse.json({ discrepancy: updated, missionId: mission.id, alreadyPromoted: false });
}
