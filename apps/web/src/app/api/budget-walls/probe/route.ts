/**
 * POST /api/budget-walls/probe — ask the team's runners to probe their provider
 * walls now. Clients and agents cannot see a runner's login, so this only
 * raises a request the runners' heartbeats pick up; each runner probes and
 * reports, and only a passing probe clears the wall (lib/budget-wall-probe.ts).
 *
 * Auth: a runner/worker API key (the caller's team), or a signed-in team member
 * with `{ teamId? }`. 200 { requested: <accounts asked> }
 */
import { NextRequest, NextResponse } from 'next/server';
import { authenticateApiKey } from '@/lib/api-auth';
import { requireSessionUser } from '@/lib/auth-helpers';
import { getUserTeamIds, resolveActiveTeamId } from '@/lib/team-access';
import { requestBudgetWallProbe } from '@/lib/budget-wall-probe';

export async function POST(req: NextRequest) {
  const apiKey = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? null;
  let teamId: string | null = null;

  if (apiKey) {
    const account = await authenticateApiKey(apiKey, req);
    if (!account) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    if (account.level === 'trigger') {
      return NextResponse.json({ error: 'Trigger tokens cannot request probes' }, { status: 403 });
    }
    teamId = (account as { teamId: string }).teamId;
  } else {
    const session = await requireSessionUser(req);
    if (session.response) return session.response;
    const body = await req.json().catch(() => ({})) as { teamId?: string };
    const teamIds = await getUserTeamIds(session.user.id);
    teamId = body.teamId || await resolveActiveTeamId(session.user.id, req.cookies.get('buildd-team')?.value ?? null);
    if (!teamId || !teamIds.includes(teamId)) return NextResponse.json({ error: 'Team not found' }, { status: 404 });
  }

  try {
    const requested = await requestBudgetWallProbe(teamId);
    return NextResponse.json({ requested });
  } catch (error) {
    console.error('POST /api/budget-walls/probe error:', error);
    return NextResponse.json({ error: 'Failed to request probe' }, { status: 500 });
  }
}
