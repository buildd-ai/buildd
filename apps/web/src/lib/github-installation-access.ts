// Which teams a GitHub App installation belongs to, and what a user may do
// with it. Installations carry no team column, so ownership is derived:
//
//   - teams with a workspace already linked to an installation of the same
//     GitHub account (org/user) — this is what carries ownership across an App
//     uninstall/reinstall, which mints a new installation row; and
//   - the teams of the user who ran the install flow (installedByUserId).
//
// Linking a workspace to a repo, listing an installation's repos, syncing and
// disconnecting are all bounded by this set.

import { db } from '@buildd/core/db';
import { workspaces } from '@buildd/core/db/schema';
import { eq, sql } from 'drizzle-orm';
import { getUserTeamIds } from '@/lib/team-access';
import { teamIdsWhere } from '@/lib/permissions';
import { sqlWhere } from '@buildd/core/db/relational-sql';

/**
 * The teams that own the installation with row id `installationDbId`, by the same rule
 * `installationBelongsToTeam` reads for one team (one read): teams with a workspace linked
 * to an installation of the same GitHub account, through the workspace's repo or its
 * direct pointer, and the teams of the user who installed it (their memberships and
 * personal team, as `getUserTeamIds` counts them).
 */
export async function getInstallationOwnerTeamIds(installationDbId: string): Promise<string[]> {
  const r = await db.execute(sql`
    SELECT DISTINCT t.team_id FROM github_installations gi
    CROSS JOIN LATERAL (
      SELECT w.team_id FROM github_installations s
      JOIN workspaces w ON w.github_installation_id = s.id
      WHERE s.account_id = gi.account_id
      UNION
      SELECT w.team_id FROM github_installations s
      JOIN github_repos r ON r.installation_id = s.id
      JOIN workspaces w ON w.github_repo_id = r.id
      WHERE s.account_id = gi.account_id
      UNION
      SELECT m.team_id FROM team_members m WHERE m.user_id = gi.installed_by_user_id
      UNION
      SELECT p.id FROM teams p WHERE p.slug = 'personal-' || gi.installed_by_user_id::text
    ) t
    WHERE gi.id = ${installationDbId}::uuid AND t.team_id IS NOT NULL`);
  return (((r as unknown as { rows?: Array<{ team_id: string }> }).rows ?? [])).map((row) => row.team_id);
}

export interface InstallationAccess {
  /** A member of an owning team, or the installer. */
  canView: boolean;
  /** Holds manage_github_installation in an owning team, or is the installer. */
  canManage: boolean;
  /**
   * Teams with a workspace on this installation in which the user does not
   * hold manage_github_installation. Disconnecting would cut those workspaces
   * off, so it is refused while this is non-empty.
   */
  otherTeamsUsingIt: string[];
}

export async function getInstallationAccessForUser(
  userId: string,
  installation: { id: string; installedByUserId: string | null },
): Promise<InstallationAccess> {
  const [ownerTeamIds, userTeamIds, managerTeamIds, direct] = await Promise.all([
    getInstallationOwnerTeamIds(installation.id),
    getUserTeamIds(userId),
    teamIdsWhere({ kind: 'user', userId }, 'manage_github_installation'),
    db.query.workspaces.findMany({
      where: sqlWhere(eq(workspaces.githubInstallationId, installation.id)),
      columns: { teamId: true },
    }),
  ]);
  const isInstaller = installation.installedByUserId === userId;
  return {
    canView: isInstaller || ownerTeamIds.some(t => userTeamIds.includes(t)),
    canManage: isInstaller || ownerTeamIds.some(t => managerTeamIds.includes(t)),
    otherTeamsUsingIt: [...new Set(direct.map(w => w.teamId))].filter(t => !managerTeamIds.includes(t)),
  };
}

/**
 * Whether the installation with GitHub's numeric id `installationId` belongs to
 * `teamId`, by the ownership rule above, in one read: an installation on a GitHub
 * account the team already has a workspace linked to (through the workspace's repo,
 * which follows a reinstall, or its direct installation pointer), or one a member
 * of the team installed.
 *
 * Every command acts only through its own team's installation: the control plane
 * (lib/workflow/command-installation.ts) and the doors that pick an installation
 * for a PR in a repo other than the workspace's own (pr-supersession.ts,
 * ci-red-sweep-deps.ts) refuse any other.
 */
export async function installationBelongsToTeam(installationId: number, teamId: string): Promise<boolean> {
  const r = await db.execute(sql`
    SELECT 1 FROM github_installations gi
    WHERE gi.installation_id = ${installationId}
      AND (
        EXISTS (
          SELECT 1 FROM github_installations s
          WHERE s.account_id = gi.account_id
            AND (
              EXISTS (SELECT 1 FROM workspaces w WHERE w.team_id = ${teamId}::uuid AND w.github_installation_id = s.id)
              OR EXISTS (
                SELECT 1 FROM workspaces w JOIN github_repos r ON r.id = w.github_repo_id
                WHERE w.team_id = ${teamId}::uuid AND r.installation_id = s.id
              )
            )
        )
        OR EXISTS (SELECT 1 FROM team_members m WHERE m.team_id = ${teamId}::uuid AND m.user_id = gi.installed_by_user_id)
        -- The installer's personal team, as getUserTeamIds counts it for an account with no membership row.
        OR EXISTS (SELECT 1 FROM teams p WHERE p.id = ${teamId}::uuid AND p.slug = 'personal-' || gi.installed_by_user_id::text)
      )
    LIMIT 1`);
  return (((r as { rows?: unknown[] }).rows ?? []) as unknown[]).length > 0;
}
