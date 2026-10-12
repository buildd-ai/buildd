/**
 * Who may read or change a team's tier pools. Everyone in the team reads.
 * Writes (alternates, the dial, split and explore, weights) are a platform
 * operator control, not a team permission (lib/admin/platform-operator-caller.ts): a team
 * owner or admin picks only the primary, through /api/model-tiers, which keeps
 * the pool's incumbent in step. Session only: pools are a settings screen,
 * not an API-key surface.
 */
import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth-helpers';
import { getUserTeamRole } from '@/lib/team-access';
import { roleHas } from '@/lib/permissions';
import { isPlatformOperatorCaller, operatorOnlyResponse } from '@/lib/admin/platform-operator-caller';

export type PoolAccess =
  | { ok: true; userId: string; teamId: string; isAdmin: boolean; isOperator: boolean }
  | { ok: false; response: NextResponse };

export async function tierPoolAccess(teamId: unknown, write: boolean): Promise<PoolAccess> {
  const fail = (status: number, error: string): PoolAccess => ({ ok: false, response: NextResponse.json({ error }, { status }) });
  const user = await getCurrentUser();
  if (!user) return fail(401, 'Unauthorized');
  if (typeof teamId !== 'string' || !teamId) return fail(400, 'teamId is required');
  const role = await getUserTeamRole(user.id, teamId);
  if (!role) return fail(404, 'Team not found');
  const isAdmin = roleHas(role, 'manage_model_tiers');
  const isOperator = await isPlatformOperatorCaller({ user });
  if (write && !isOperator) return { ok: false, response: operatorOnlyResponse() };
  return { ok: true, userId: user.id, teamId, isAdmin, isOperator };
}
