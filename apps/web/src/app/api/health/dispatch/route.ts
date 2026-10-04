import { NextRequest, NextResponse } from 'next/server';
import { authenticateApiKey } from '@/lib/api-auth';
import { getCurrentUser } from '@/lib/auth-helpers';
import { resolveSessionTeamIds, workspaceIdsForTeams } from '@/lib/session-team-scope';
import { db } from '@buildd/core/db';
import { workspaces } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { getDispatchHealth } from '@/lib/dispatch-health';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /api/health/dispatch — Dispatch transport health for the caller's team:
 * the `dispatch_health` MCP action's backend, and the same lib
 * (lib/dispatch-health.ts) the /app/health Dispatch section renders.
 *
 * Query params:
 *   workspaceId — optional UUID; one workspace of the caller's team. Another
 *                 team's workspace 404s.
 *   teamId      — dashboard session only: pin to one of the user's teams.
 *
 * Auth and scope match /api/health/failures: an API key reads its own team;
 * a session reads the user's teams (or the pinned one). Read-only.
 *
 * Response: DispatchHealthReport (@buildd/core/dispatch-health-report).
 */
export async function GET(req: NextRequest) {
  try {
    const apiKey = req.headers.get('authorization')?.replace('Bearer ', '') ?? null;
    const account = await authenticateApiKey(apiKey, req);
    const sessionUser = account ? null : await getCurrentUser();
    if (!account && !sessionUser) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { searchParams } = new URL(req.url);
    let teamIds: string[];
    if (account) {
      teamIds = account.teamId ? [account.teamId] : [];
    } else {
      const sessionTeamIds = await resolveSessionTeamIds(sessionUser!.id, searchParams.get('teamId'));
      if (!sessionTeamIds) return NextResponse.json({ error: 'Team not found' }, { status: 404 });
      teamIds = sessionTeamIds;
    }
    if (teamIds.length === 0) return NextResponse.json({ error: 'No team associated with this account' }, { status: 400 });

    const workspaceId = searchParams.get('workspaceId');
    let scoped: string[];
    if (workspaceId) {
      if (!UUID_RE.test(workspaceId)) {
        return NextResponse.json({ error: `Invalid workspaceId: expected a UUID, got "${workspaceId}".` }, { status: 400 });
      }
      const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId), columns: { id: true, teamId: true } });
      if (!ws || !teamIds.includes(ws.teamId)) {
        return NextResponse.json({ error: 'Workspace not found or not in your team' }, { status: 404 });
      }
      scoped = [workspaceId];
    } else if (account) {
      const rows = await db.query.workspaces.findMany({ where: eq(workspaces.teamId, account.teamId), columns: { id: true } });
      scoped = rows.map((w: { id: string }) => w.id);
    } else {
      scoped = await workspaceIdsForTeams(teamIds);
    }

    return NextResponse.json(await getDispatchHealth(scoped));
  } catch (err) {
    console.error('[health/dispatch] read failed:', err);
    return NextResponse.json({ error: 'Failed to read dispatch health' }, { status: 500 });
  }
}
