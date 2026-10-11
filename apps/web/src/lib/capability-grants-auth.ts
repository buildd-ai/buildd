/**
 * Who may read and change capability policy and decide capability requests.
 *
 * Only a signed-in person. Any bearer credential is refused outright, an
 * admin key included: an agent run holds keys, and a key that could approve
 * its own request or loosen its team's policy would let an agent escalate
 * itself. Changing anything needs `manage_connectors` in the team (owners and
 * admins by default, with the team's permission overrides applied); any team
 * member may read.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth-helpers';
import { getUserTeamIds } from '@/lib/team-access';
import { can } from '@/lib/permissions';

export interface CapabilityAdminCaller {
  userId: string;
  teamId: string;
  canManage: boolean;
}

export const SESSION_REQUIRED = {
  error: 'session_required',
  message: 'Capability policy and approvals need a signed-in person. API keys, including agent keys, cannot read or change them.',
};

export function hasBearer(req: NextRequest): boolean {
  return /^Bearer\s+\S/i.test(req.headers.get('authorization') ?? '');
}

/** The session user and the team they act on: `teamId` if given and theirs, else the active-team cookie, else their first team. */
export async function resolveCapabilityAdminCaller(req: NextRequest, teamId?: string | null): Promise<CapabilityAdminCaller | NextResponse> {
  if (hasBearer(req)) return NextResponse.json(SESSION_REQUIRED, { status: 403 });
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const teamIds = await getUserTeamIds(user.id);
  let team: string | undefined;
  if (teamId) {
    // Another team's id answers as not found, never forbidden.
    if (!teamIds.includes(teamId)) return NextResponse.json({ error: 'Team not found' }, { status: 404 });
    team = teamId;
  } else {
    const cookie = req.cookies.get('buildd-team')?.value;
    team = cookie && teamIds.includes(cookie) ? cookie : teamIds[0];
  }
  if (!team) return NextResponse.json({ error: 'No team found' }, { status: 400 });
  const canManage = await can({ kind: 'user', userId: user.id }, 'manage_connectors', team);
  return { userId: user.id, teamId: team, canManage };
}

export const MANAGE_FORBIDDEN = () => NextResponse.json(
  { error: 'forbidden', message: 'Only a team member who can manage connectors (owners and admins by default) can change capability policy or decide requests.' },
  { status: 403 },
);
