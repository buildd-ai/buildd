import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { teamMembers } from '@buildd/core/db/schema';
import { and, eq } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { getUserTeamIds } from '@/lib/team-access';
import { hasTokenRouteAdminAccess } from '@/lib/token-route-policy';
import { roleHas, getTeamPermissionOverrides } from '@/lib/permissions';

export interface ConnectorTeamCaller {
  teamId: string;
  /** May the caller change connectors/catalog for this team (spec §6). */
  canManage: boolean;
  accountId: string | null;
}

/**
 * Resolve which team a connector-catalog request acts on, mirroring
 * /api/connectors: an admin-level API key acts on its own team; a session
 * user on the active-team cookie (else their first team). Personal teams have
 * no team_members row and are owned by the caller.
 */
export async function resolveConnectorTeam(req: NextRequest): Promise<ConnectorTeamCaller | NextResponse> {
  const apiKey = req.headers.get('authorization')?.replace('Bearer ', '') || null;
  if (apiKey) {
    const account = await authenticateApiKey(apiKey, req);
    if (account) {
      if (!hasTokenRouteAdminAccess(account, req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      return { teamId: account.teamId, canManage: true, accountId: account.id };
    }
  }
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const teamIds = await getUserTeamIds(user.id);
  if (teamIds.length === 0) return NextResponse.json({ error: 'No team found' }, { status: 400 });
  const cookieTeamId = req.cookies.get('buildd-team')?.value;
  const teamId = cookieTeamId && teamIds.includes(cookieTeamId) ? cookieTeamId : teamIds[0];
  const membership = await db.query.teamMembers.findFirst({
    where: and(eq(teamMembers.userId, user.id), eq(teamMembers.teamId, teamId)),
    columns: { role: true },
  });
  const canManage = !membership || roleHas(membership.role, 'manage_connectors', await getTeamPermissionOverrides(teamId));
  return { teamId, canManage, accountId: null };
}

export const forbidden = () => NextResponse.json({ error: 'Forbidden' }, { status: 403 });
