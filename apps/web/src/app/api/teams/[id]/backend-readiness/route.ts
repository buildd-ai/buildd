/**
 * GET /api/teams/[id]/backend-readiness
 *
 * Per-backend configuration readiness for a team, and — the part that matters —
 * how much pending work each backend is currently STRANDING: tasks whose
 * effective backend has no credential, which therefore no runner can ever claim.
 *
 * Feeds Settings → Agent backends. "Not configured" on its own is a shrug; the
 * same fact with "4 pending tasks can never be claimed" next to it is a bug
 * report. See `apps/web/src/lib/backend-strand.ts` for how the effective backend
 * is resolved (shared with the claim route and the queue-stall watchdog).
 *
 * Auth: session or API key, team membership required.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getUserFromRequest } from '@/lib/auth-helpers';
import { getTeamWorkspaceIds, getUserTeamIds } from '@/lib/team-access';
import { getBackendStrandSummary } from '@/lib/backend-strand';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: teamId } = await params;

  const user = await getUserFromRequest(req);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const teamIds = await getUserTeamIds(user.id);
  if (!teamIds.includes(teamId)) {
    // 404 rather than 403 — do not confirm the team exists.
    return NextResponse.json({ error: 'Team not found' }, { status: 404 });
  }

  try {
    const workspaceIds = await getTeamWorkspaceIds(teamId);
    const summary = await getBackendStrandSummary({ teamId, workspaceIds });
    return NextResponse.json(summary);
  } catch (error) {
    console.error('[backend-readiness] rollup failed:', error);
    return NextResponse.json({ error: 'Failed to compute backend readiness' }, { status: 500 });
  }
}
