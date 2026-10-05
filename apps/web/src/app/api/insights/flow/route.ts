import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth-helpers';
import { getUserTeamIds, resolveActiveTeamId } from '@/lib/team-access';
import { can } from '@/lib/permissions';
import { FLOW_WINDOWS, isFlowWindow } from '@/lib/insights-flow';
import { loadFlowSeries, teamWorkspaceIds } from '@/lib/insights-flow-query';

/**
 * GET /api/insights/flow?window=7d|30d&team=<teamId>
 *
 * How one team's agent work moved to production over the window: stage bands
 * per time bucket, release markers, the tasks behind each band, and the
 * headline (share of agent-hours that shipped). See lib/insights-flow.ts for
 * the stage rules.
 *
 * Session only, and only for team roles holding `view_team_usage` (admins and
 * owners by default): it shows every member's work. `team` defaults to the
 * active team; a team the caller isn't in is a 404, not a 403, so membership
 * of other teams doesn't leak.
 */
export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const url = new URL(req.url);
  const rawWindow = url.searchParams.get('window') ?? '7d';
  if (!isFlowWindow(rawWindow)) {
    return NextResponse.json({ error: `Invalid window: "${rawWindow}". Expected one of ${FLOW_WINDOWS.join(', ')}.` }, { status: 400 });
  }

  const requested = url.searchParams.get('team');
  let teamId: string | null;
  if (requested) {
    const teamIds = await getUserTeamIds(user.id);
    if (!teamIds.includes(requested)) return NextResponse.json({ error: 'Team not found' }, { status: 404 });
    teamId = requested;
  } else {
    teamId = await resolveActiveTeamId(user.id, req.cookies.get('buildd-team')?.value);
  }
  if (!teamId) return NextResponse.json({ error: 'Team not found' }, { status: 404 });

  if (!(await can({ kind: 'user', userId: user.id }, 'view_team_usage', teamId))) {
    return NextResponse.json({ error: 'Insights are visible to team admins' }, { status: 403 });
  }

  const workspaceIds = await teamWorkspaceIds(teamId);
  const series = await loadFlowSeries(workspaceIds, rawWindow);
  return NextResponse.json({ ...series, teamId, windowKey: rawWindow });
}
