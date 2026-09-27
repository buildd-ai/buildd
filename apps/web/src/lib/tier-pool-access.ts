/**
 * Who may read or change a team's tier pools. Everyone in the team reads;
 * only owners and admins write, as for the tier registry itself
 * (docs/design/tier-model-pools.md §9). Session only: pools are an admin
 * screen, not an API-key surface, in P1.
 */
import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth-helpers';
import { getUserTeamRole } from '@/lib/team-access';

export type PoolAccess =
  | { ok: true; userId: string; teamId: string; isAdmin: boolean }
  | { ok: false; response: NextResponse };

export async function tierPoolAccess(teamId: unknown, write: boolean): Promise<PoolAccess> {
  const fail = (status: number, error: string): PoolAccess => ({ ok: false, response: NextResponse.json({ error }, { status }) });
  const user = await getCurrentUser();
  if (!user) return fail(401, 'Unauthorized');
  if (typeof teamId !== 'string' || !teamId) return fail(400, 'teamId is required');
  const role = await getUserTeamRole(user.id, teamId);
  if (!role) return fail(404, 'Team not found');
  const isAdmin = role === 'owner' || role === 'admin';
  if (write && !isAdmin) return fail(403, 'Only a team owner or admin can change model traffic');
  return { ok: true, userId: user.id, teamId, isAdmin };
}
