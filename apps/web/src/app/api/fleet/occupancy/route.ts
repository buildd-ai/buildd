import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth-helpers';
import { getUserTeamIds, resolveActiveTeamId } from '@/lib/team-access';
import { OCCUPANCY_WINDOWS, isOccupancyWindow } from '@/lib/fleet-occupancy';
import { loadOccupancySeries, teamWorkspaceIds } from '@/lib/fleet-occupancy-query';

/**
 * GET /api/fleet/occupancy?window=24h|7d|30d&team=<teamId>&workspace=<id>
 *
 * How many workers were busy over the window, runner slots and interactive
 * sessions apart (lib/fleet-occupancy.ts). Any member of the team: it is the
 * caller's own fleet, the same one Home shows. Every window on every plan
 * (knowledge-base: buildd/plans/billing-v1.md rules out history windows).
 *
 * `team` defaults to the active team; a team the caller isn't in is a 404.
 * `workspace` narrows to one of that team's workspaces; any other id is ignored.
 */
export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const url = new URL(req.url);
  const rawWindow = url.searchParams.get('window') ?? '24h';
  if (!isOccupancyWindow(rawWindow)) {
    return NextResponse.json({ error: `Invalid window: "${rawWindow}". Expected one of ${OCCUPANCY_WINDOWS.join(', ')}.` }, { status: 400 });
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

  const teamWs = await teamWorkspaceIds(teamId);
  const ws = url.searchParams.get('workspace');
  const scope = ws && teamWs.includes(ws) ? [ws] : teamWs;
  const series = await loadOccupancySeries(scope, rawWindow);
  return NextResponse.json({ ...series, teamId });
}
