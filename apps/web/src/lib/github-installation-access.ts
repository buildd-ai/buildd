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
import { githubInstallations, workspaces } from '@buildd/core/db/schema';
import { eq, inArray } from 'drizzle-orm';
import { getUserTeamIds, getUserAdminTeamIds } from '@/lib/team-access';

export async function getInstallationOwnerTeamIds(installationDbId: string): Promise<string[]> {
  const installation = await db.query.githubInstallations.findFirst({
    where: eq(githubInstallations.id, installationDbId),
    columns: { id: true, accountId: true, installedByUserId: true },
  });
  if (!installation) return [];

  const sameAccount = await db.query.githubInstallations.findMany({
    where: eq(githubInstallations.accountId, installation.accountId),
    columns: { id: true },
  });
  const installationIds = [...new Set([installation.id, ...sameAccount.map(i => i.id)])];

  const [linked, installerTeams] = await Promise.all([
    db.query.workspaces.findMany({
      where: inArray(workspaces.githubInstallationId, installationIds),
      columns: { teamId: true },
    }),
    installation.installedByUserId ? getUserTeamIds(installation.installedByUserId) : Promise.resolve([] as string[]),
  ]);

  return [...new Set([...linked.map(w => w.teamId), ...installerTeams])];
}

export interface InstallationAccess {
  /** A member of an owning team, or the installer. */
  canView: boolean;
  /** An admin/owner of an owning team, or the installer. */
  canManage: boolean;
  /**
   * Teams with a workspace on this installation that the user does not
   * administer. Disconnecting would cut those workspaces off, so it is refused
   * while this is non-empty.
   */
  otherTeamsUsingIt: string[];
}

export async function getInstallationAccessForUser(
  userId: string,
  installation: { id: string; installedByUserId: string | null },
): Promise<InstallationAccess> {
  const [ownerTeamIds, userTeamIds, adminTeamIds, direct] = await Promise.all([
    getInstallationOwnerTeamIds(installation.id),
    getUserTeamIds(userId),
    getUserAdminTeamIds(userId),
    db.query.workspaces.findMany({
      where: eq(workspaces.githubInstallationId, installation.id),
      columns: { teamId: true },
    }),
  ]);
  const isInstaller = installation.installedByUserId === userId;
  return {
    canView: isInstaller || ownerTeamIds.some(t => userTeamIds.includes(t)),
    canManage: isInstaller || ownerTeamIds.some(t => adminTeamIds.includes(t)),
    otherTeamsUsingIt: [...new Set(direct.map(w => w.teamId))].filter(t => !adminTeamIds.includes(t)),
  };
}
