import { cache } from 'react';
import { db } from '@buildd/core/db';
import { accounts, workspaces } from '@buildd/core/db/schema';
import { desc, inArray } from 'drizzle-orm';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth-helpers';
import { getUserWorkspaceIds, getUserTeamsWithDetails, resolveActiveTeamId, type UserTeam } from '@/lib/team-access';
import { isSystemWorkspace } from '@buildd/shared';

export interface SettingsWorkspace {
  id: string;
  name: string;
  repo: string | null;
  teamId: string;
}

export interface SettingsContext {
  user: NonNullable<Awaited<ReturnType<typeof getCurrentUser>>>;
  teams: UserTeam[];
  currentTeamId: string | null;
  currentTeam: UserTeam | null;
  /** Owner or admin of the active team (a personal team counts as owner). */
  isTeamAdmin: boolean;
  workspaces: SettingsWorkspace[];
}

/**
 * What every settings section needs: the signed-in user, their teams, the
 * active team (resolveActiveTeamId: the `buildd-team` cookie, else the shell's default) and the
 * workspaces they can see. Each read degrades to empty on failure so one bad
 * query blanks a section, not the page. Cached per request.
 */
export const loadSettingsContext = cache(async (): Promise<SettingsContext> => {
  const user = await getCurrentUser();
  if (!user) redirect('/app/auth/signin');

  const [teams, wsIds] = await Promise.all([
    getUserTeamsWithDetails(user.id).catch((e) => {
      console.error('Settings: teams query error:', e);
      return [] as UserTeam[];
    }),
    getUserWorkspaceIds(user.id).catch(() => [] as string[]),
  ]);

  // The same resolver the shell, Home and chat use (cookie, else
  // pickDefaultTeam), so a settings section can never act on a different team
  // than the header shows. `teams[0]` used to stand in for the default here.
  const teamCookie = (await cookies()).get('buildd-team')?.value;
  const currentTeamId = await resolveActiveTeamId(user.id, teamCookie).catch(() => null);
  const currentTeam = teams.find((t) => t.id === currentTeamId) ?? null;
  const isTeamAdmin = !!currentTeam && (
    currentTeam.role === 'owner' || currentTeam.role === 'admin' || currentTeam.slug === `personal-${user.id}`
  );

  const rows = wsIds.length > 0
    ? await db.query.workspaces.findMany({
        where: inArray(workspaces.id, wsIds),
        columns: { id: true, name: true, repo: true, teamId: true },
      }).catch(() => [] as SettingsWorkspace[])
    : [];

  return {
    user,
    teams,
    currentTeamId,
    currentTeam,
    isTeamAdmin,
    workspaces: (rows as SettingsWorkspace[]).filter((ws) => !isSystemWorkspace(ws.name)),
  };
});

/** Runner accounts (tokens) across the user's teams, for the Runners section. */
export async function loadRunnerAccounts(teamIds: string[]) {
  if (teamIds.length === 0) return [];
  const rows = await db.query.accounts.findMany({
    where: inArray(accounts.teamId, teamIds),
    orderBy: desc(accounts.createdAt),
    with: {
      team: { columns: { name: true } },
      accountWorkspaces: { columns: { workspaceId: true } },
    },
  }).catch(() => [] as any[]);
  return rows.map((a: any) => ({ ...a, hasOauthToken: !!a.oauthToken }));
}
