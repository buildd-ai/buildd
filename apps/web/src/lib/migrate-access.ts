import { hasTokenRouteAdminAccess } from '@/lib/token-route-policy';
/**
 * Shared auth gate for the workspace-migration endpoints.
 *
 * Mirrors the connector-transfer precedent (apps/web/src/app/api/connectors/[id]/transfer):
 * a session user's `teamIds` is every team they belong to, so cross-team migration is a
 * session-admin operation; an admin API key is scoped to a single team and therefore cannot
 * cross teams (it will fail the both-teams check) — consistent and intentional.
 */
import { NextRequest } from 'next/server';
import { db } from '@buildd/core/db';
import { teamMembers } from '@buildd/core/db/schema';
import { eq, and } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { getUserTeamIds } from '@/lib/team-access';
import { roleHas, getTeamPermissionOverrides } from '@/lib/permissions';

export type MigrationAuth =
  | { type: 'api'; teamIds: string[]; userId: null }
  | { type: 'session'; teamIds: string[]; userId: string }
  | { type: 'dev' }
  | { type: 'denied' }
  | null;

export async function authenticateMigration(req: NextRequest): Promise<MigrationAuth> {
  const apiKey = req.headers.get('authorization')?.replace('Bearer ', '') || null;
  if (apiKey) {
    const account = await authenticateApiKey(apiKey, req);
    if (account) {
      if (!hasTokenRouteAdminAccess(account, req)) return { type: 'denied' };
      return { type: 'api', teamIds: [account.teamId], userId: null };
    }
  }
  if (process.env.NODE_ENV !== 'development') {
    const user = await getCurrentUser();
    if (user) return { type: 'session', teamIds: await getUserTeamIds(user.id), userId: user.id };
  } else {
    return { type: 'dev' };
  }
  return null;
}

/** Team-admin gate (spec: admin/owner on both teams). Absent team_members row = personal team = allowed. */
export async function isTeamAdmin(userId: string, teamId: string): Promise<boolean> {
  const membership = await db.query.teamMembers.findFirst({
    where: and(eq(teamMembers.userId, userId), eq(teamMembers.teamId, teamId)),
    columns: { role: true },
  });
  // No row = the caller's personal team, which they own.
  if (!membership) return true;
  return roleHas(membership.role, 'migrate_workspace', await getTeamPermissionOverrides(teamId));
}
