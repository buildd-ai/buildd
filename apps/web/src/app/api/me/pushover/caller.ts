import { NextResponse, type NextRequest } from 'next/server';
import { requireSessionUser } from '@/lib/auth-helpers';
import { getUserTeamIds, resolveActiveTeamId } from '@/lib/team-access';

/**
 * The signed-in person and the team their key is scoped to. Session only: a
 * personal channel belongs to a person, and API keys are not people.
 */
export async function resolvePushoverCaller(
  req: NextRequest,
  requestedTeamId: string | null | undefined,
): Promise<{ userId: string; teamId: string } | { response: Response }> {
  const session = await requireSessionUser(req);
  if (session.response) return { response: session.response };
  const userId = session.user.id;
  const teamIds = await getUserTeamIds(userId);
  const teamId = requestedTeamId || await resolveActiveTeamId(userId, req.cookies.get('buildd-team')?.value ?? null);
  if (!teamId || !teamIds.includes(teamId)) return { response: NextResponse.json({ error: 'Team not found' }, { status: 404 }) };
  return { userId, teamId };
}
