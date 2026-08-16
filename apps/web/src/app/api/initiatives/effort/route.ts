import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { workspaces } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { resolveAccountTeamIds } from '@/lib/team-access';
import { loadInitiativeEffort } from '@/lib/initiative-pulse';

// GET /api/initiatives/effort?workspaceId=<id>
// Per-initiative daily token totals and worker outcome counts over the last 14 days.
//
// The aggregation itself lives in lib/initiative-pulse.ts — this route is auth,
// scoping and serialisation only, so it can never drift from the server
// components that read the same window (spec: surface-ia-home-missions-initiatives §6.2).
//
// `days` is a dense 14-entry window ending today, and missions with no
// initiative are keyed '__unassigned__'.
export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  const apiAccount = await authenticateApiKey(apiKey);

  if (!user && !apiAccount) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const workspaceId = searchParams.get('workspaceId');

  if (!workspaceId) {
    return NextResponse.json({ error: 'workspaceId is required' }, { status: 400 });
  }

  try {
    const teamIds = await resolveAccountTeamIds(user, apiAccount);

    const ws = await db.query.workspaces.findFirst({
      where: eq(workspaces.id, workspaceId),
      columns: { id: true, teamId: true },
    });
    if (!ws || !teamIds.includes(ws.teamId)) {
      return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
    }

    const byInitiative = await loadInitiativeEffort({ workspaceId });

    const efforts = [...byInitiative.entries()].map(([initiativeId, days]) => ({
      initiativeId,
      days,
    }));

    return NextResponse.json({ efforts });
  } catch (error) {
    console.error('Initiative effort error:', error);
    return NextResponse.json({ error: 'Failed to load effort data' }, { status: 500 });
  }
}
