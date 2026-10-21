import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { resolveAccountTeamIds } from '@/lib/team-access';
import { hasTokenRouteAdminAccess } from '@/lib/token-route-policy';
import { workspaceOpenToCaller } from '@/lib/open-workspaces';
import { db } from '@buildd/core/db';
import { missions } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { sqlWhere } from '@buildd/core/db/relational-sql';
import { isUuid } from '@/lib/uuid';
import { dbGateStore, recordAcceptanceObjection, recordAcceptanceResults } from '@/lib/specs/acceptance-gate-apply';
import type { AcceptanceTest } from '@/lib/specs/acceptance-gate';

const RESULTS = ['fail', 'pass', 'inconclusive'];

/**
 * POST /api/missions/[id]/acceptance-tests
 *
 * Body: `{ results: [{ checkId, name, startingResult, output? }] }` records test results on the
 * mission's starting commit; `{ objected: boolean }` records (or withdraws) the person's objection.
 * Either way the building gate runs (spec 1dc6cc39 R-79) and its outcome is returned.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: 'Mission not found' }, { status: 404 });

  const user = await getCurrentUser();
  const apiAccount = await authenticateApiKey(req.headers.get('authorization')?.replace('Bearer ', '') || null, req);
  if (!user && !apiAccount) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (apiAccount && !hasTokenRouteAdminAccess(apiAccount, req)) {
    return NextResponse.json({ error: 'Requires admin-level API key' }, { status: 403 });
  }

  const teamIds = await resolveAccountTeamIds(user, apiAccount);
  const mission = await db.query.missions.findFirst({
    where: sqlWhere(eq(missions.id, id)),
    columns: { id: true, teamId: true, workspaceId: true },
  });
  const allowed = !!mission && (teamIds.includes(mission.teamId)
    || (!!mission.workspaceId && await workspaceOpenToCaller(mission.workspaceId, { teamIds, accountId: apiAccount?.id })));
  if (!mission || !allowed) return NextResponse.json({ error: 'Mission not found' }, { status: 404 });

  const body = await req.json().catch(() => null) as { results?: unknown; objected?: unknown } | null;
  let outcome;
  if (typeof body?.objected === 'boolean') {
    outcome = await recordAcceptanceObjection(dbGateStore, id, body.objected);
  } else if (Array.isArray(body?.results)) {
    const results: AcceptanceTest[] = [];
    for (const r of body.results as Array<Record<string, unknown>>) {
      if (typeof r?.checkId !== 'string' || typeof r?.name !== 'string' || !RESULTS.includes(r.startingResult as string)) {
        return NextResponse.json({ error: 'Each result needs checkId, name and startingResult (fail | pass | inconclusive)' }, { status: 400 });
      }
      results.push({ checkId: r.checkId, name: r.name, startingResult: r.startingResult as AcceptanceTest['startingResult'], ...(typeof r.output === 'string' ? { output: r.output } : {}) });
    }
    outcome = await recordAcceptanceResults(dbGateStore, id, results);
  } else {
    return NextResponse.json({ error: 'Send results or objected' }, { status: 400 });
  }
  if (!outcome) return NextResponse.json({ error: 'This mission has no acceptance-tests task' }, { status: 409 });
  return NextResponse.json(outcome);
}
