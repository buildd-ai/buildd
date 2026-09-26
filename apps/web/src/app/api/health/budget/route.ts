import { NextRequest, NextResponse } from 'next/server';
import { authenticateApiKey } from '@/lib/api-auth';
import { db } from '@buildd/core/db';
import { workspaces } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { getBudgetForecast } from '@/lib/budget-forecast';
import { getCurrentUser } from '@/lib/auth-helpers';
import { getTeamWorkspaceIds, resolveActiveTeamId } from '@/lib/team-access';
import { resolveSessionTeamIds } from '@/lib/session-team-scope';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /api/health/budget
 *
 * Returns the budget forecast for the authenticated account's team.
 * Accessible via API key auth so MCP agents can call it before dispatching
 * heavy task chains (pairs with startAfter: 'budget_reset').
 *
 * Query params:
 *   workspaceId — optional UUID; scopes mission budgets to a single workspace.
 *                 Omit for team-wide forecast. Must be a UUID — pass through
 *                 resolveWorkspaceId on the MCP layer before calling this route.
 *   teamId      — dashboard session only: forecast this one of the user's teams.
 *                 A team the user is not in 404s. Ignored on the key path.
 *
 * Auth: API key (the key's team) or the dashboard session. A forecast is for
 * one team, so a session resolves one: the workspace's team when workspaceId
 * is given, else the pinned teamId, else the active team (`buildd-team`
 * cookie, as the health page does). A key, when present, is authoritative.
 */
export async function GET(req: NextRequest) {
  try {
    const authHeader = req.headers.get('authorization');
    const apiKey = authHeader?.replace('Bearer ', '') ?? null;
    const account = await authenticateApiKey(apiKey);
    if (!account) {
      const sessionUser = await getCurrentUser();
      if (!sessionUser) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      }
      return await sessionForecast(req, sessionUser.id);
    }

    if (!account.teamId) {
      return NextResponse.json({ error: 'No team associated with this account' }, { status: 400 });
    }

    const { searchParams } = new URL(req.url);
    const workspaceId = searchParams.get('workspaceId') ?? null;

    let scopedWsIds: string[];
    if (workspaceId) {
      if (!UUID_RE.test(workspaceId)) {
        return NextResponse.json(
          { error: `Invalid workspaceId: expected a UUID, got "${workspaceId}". Resolve workspace names to UUIDs before calling this endpoint.` },
          { status: 400 },
        );
      }
      // Validate the workspace belongs to the account's team
      const ws = await db.query.workspaces.findFirst({
        where: eq(workspaces.id, workspaceId),
        columns: { id: true, teamId: true },
      });
      if (!ws || ws.teamId !== account.teamId) {
        return NextResponse.json({ error: 'Workspace not found or not in your team' }, { status: 404 });
      }
      scopedWsIds = [workspaceId];
    } else {
      // All workspaces in the team
      const wsRows = await db.query.workspaces.findMany({
        where: eq(workspaces.teamId, account.teamId),
        columns: { id: true },
      });
      scopedWsIds = wsRows.map(w => w.id);
    }

    const forecast = await getBudgetForecast(account.teamId, scopedWsIds);
    return NextResponse.json({ forecast });
  } catch (err) {
    console.error('[GET /api/health/budget] Unhandled error:', err);
    const message = err instanceof Error ? err.message : 'Internal server error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * The dashboard-session forecast: the same team/workspace authorization the
 * health page applies — membership of the team whose forecast is read. Any
 * team or workspace outside the user's teams 404s.
 */
async function sessionForecast(req: NextRequest, userId: string) {
  const { searchParams } = new URL(req.url);
  const workspaceId = searchParams.get('workspaceId') ?? null;
  const pinTeamId = searchParams.get('teamId');

  const teamIds = await resolveSessionTeamIds(userId, pinTeamId);
  if (!teamIds) {
    return NextResponse.json({ error: 'Team not found' }, { status: 404 });
  }
  if (teamIds.length === 0) {
    return NextResponse.json({ error: 'No team associated with this account' }, { status: 400 });
  }

  if (workspaceId) {
    if (!UUID_RE.test(workspaceId)) {
      return NextResponse.json(
        { error: `Invalid workspaceId: expected a UUID, got "${workspaceId}". Resolve workspace names to UUIDs before calling this endpoint.` },
        { status: 400 },
      );
    }
    const ws = await db.query.workspaces.findFirst({
      where: eq(workspaces.id, workspaceId),
      columns: { id: true, teamId: true },
    });
    if (!ws || !teamIds.includes(ws.teamId)) {
      return NextResponse.json({ error: 'Workspace not found or not in your team' }, { status: 404 });
    }
    return NextResponse.json({ forecast: await getBudgetForecast(ws.teamId, [workspaceId]) });
  }

  const teamId = pinTeamId
    ? teamIds[0]
    : (await resolveActiveTeamId(userId, req.cookies.get('buildd-team')?.value)) ?? teamIds[0];
  return NextResponse.json({ forecast: await getBudgetForecast(teamId, await getTeamWorkspaceIds(teamId)) });
}
