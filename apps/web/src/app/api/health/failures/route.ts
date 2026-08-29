import { NextRequest, NextResponse } from 'next/server';
import { authenticateApiKey } from '@/lib/api-auth';
import { db } from '@buildd/core/db';
import { workspaces } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { getFailureAnalytics, parseFailureWindow, FAILURE_WINDOWS } from '@/lib/failure-analytics';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /api/health/failures
 *
 * Aggregated worker failure analytics for the authenticated account's team —
 * the same numbers the health dashboard renders, so agents and CLIs never have
 * to hand-write SQL against prod to answer "why are workers dying?".
 *
 * Query params:
 *   window      — '24h' | '7d' | '30d' (default '7d'). Unknown values are rejected.
 *   workspaceId — optional UUID; scopes the report to a single workspace.
 *                 Omit for a team-wide report. Must be a UUID — resolve names
 *                 to UUIDs on the MCP layer before calling this route.
 *
 * Response: { analytics: FailureAnalytics }
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
    const rawWindow = searchParams.get('window');
    if (rawWindow !== null && !(FAILURE_WINDOWS as readonly string[]).includes(rawWindow)) {
      return NextResponse.json(
        { error: `Invalid window: "${rawWindow}". Expected one of ${FAILURE_WINDOWS.join(', ')}.` },
        { status: 400 },
      );
    }
    const window = parseFailureWindow(rawWindow);

    const workspaceId = searchParams.get('workspaceId') ?? null;

    let scopedWsIds: string[];
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
      if (!ws || ws.teamId !== account.teamId) {
        return NextResponse.json({ error: 'Workspace not found or not in your team' }, { status: 404 });
      }
      scopedWsIds = [workspaceId];
    } else {
      const wsRows = await db.query.workspaces.findMany({
        where: eq(workspaces.teamId, account.teamId),
        columns: { id: true },
      });
      scopedWsIds = wsRows.map((w: { id: string }) => w.id);
    }

    const analytics = await getFailureAnalytics(scopedWsIds, window);
    return NextResponse.json({ analytics });
  } catch (err) {
    console.error('[GET /api/health/failures] Unhandled error:', err);
    const message = err instanceof Error ? err.message : 'Internal server error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
