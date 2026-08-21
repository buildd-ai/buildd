import { NextRequest, NextResponse } from 'next/server';
import { authenticateApiKey } from '@/lib/api-auth';
import { db } from '@buildd/core/db';
import { workspaces } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { getBudgetForecast } from '@/lib/budget-forecast';

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
 */
export async function GET(req: NextRequest) {
  try {
    const authHeader = req.headers.get('authorization');
    const apiKey = authHeader?.replace('Bearer ', '') ?? null;
    const account = await authenticateApiKey(apiKey);
    if (!account) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
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
