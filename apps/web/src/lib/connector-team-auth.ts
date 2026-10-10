import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { getUserTeamIds } from '@/lib/team-access';
import { hasTokenRouteAdminAccess } from '@/lib/token-route-policy';
import { can } from '@/lib/permissions';

export interface ConnectorTeamCaller {
  teamId: string;
  /** May the caller change connectors/catalog for this team (spec §6). */
  canManage: boolean;
  accountId: string | null;
}

/**
 * Resolve which team a connector-catalog request acts on, mirroring
 * /api/connectors: an admin-level API key acts on its own team; a session
 * user on the active-team cookie (else their first team).
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
  const canManage = await canManageTeamConnectors(user.id, teamId);
  return { teamId, canManage, accountId: null };
}

export const forbidden = () => NextResponse.json({ error: 'Forbidden' }, { status: 403 });

/**
 * May this signed-in user change connectors (and their credentials) for
 * `teamId`? They must hold `manage_connectors` there, with the team's
 * overrides applied. Fails closed: a user with no membership row in the team
 * holds nothing, unless it is their own personal team (which the registry
 * treats as owned).
 */
export async function canManageTeamConnectors(userId: string, teamId: string): Promise<boolean> {
  return can({ kind: 'user', userId }, 'manage_connectors', teamId);
}

/** The callers connector write routes accept once authenticated. */
export type ConnectorWriteCaller =
  | { type: 'session'; user: { id: string } }
  | { type: 'api'; account: { id: string; teamId: string } };

/**
 * May this caller write connectors owned by `teamId`? A session needs
 * `manage_connectors` in that team. An API key reaches only its own team, and
 * only once the route has established admin access through the token route
 * policy (`hasTokenRouteAdminAccess`), so it is asked at admin level.
 */
export async function canWriteTeamConnectors(caller: ConnectorWriteCaller, teamId: string): Promise<boolean> {
  if (caller.type === 'api') {
    return can(
      { kind: 'account', accountId: caller.account.id, teamId: caller.account.teamId, level: 'admin' },
      'manage_connectors',
      teamId,
    );
  }
  return canManageTeamConnectors(caller.user.id, teamId);
}
