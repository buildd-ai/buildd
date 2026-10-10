import { db } from '@buildd/core/db';
import { githubInstallations, workspaces } from '@buildd/core/db/schema';
import { eq, inArray, or } from 'drizzle-orm';
import { getUserWorkspaceIds } from '@/lib/team-access';
import { getInstallationAccessForUser } from '@/lib/github-installation-access';

/**
 * The installations, of the ones Settings → GitHub lists, that this person
 * could disconnect: the DELETE route's own rule (getInstallationAccessForUser:
 * its installer, or a manager of a team it belongs to, and no workspace of a
 * team they do not manage still uses it). Same visibility as the list route:
 * installations a visible workspace points at, or ones they installed.
 *
 * Empty on any failure, so a read error hides Disconnect rather than offering
 * a button the API would refuse. Sync stays open to everyone who can see it.
 */
export async function loadDisconnectableInstallationIds(userId: string): Promise<string[]> {
  try {
    const wsIds = await getUserWorkspaceIds(userId);
    const linked = wsIds.length
      ? await db.query.workspaces.findMany({
          where: inArray(workspaces.id, wsIds),
          columns: { githubInstallationId: true },
        })
      : [];
    const ids = [...new Set(linked.map((w) => w.githubInstallationId).filter((id): id is string => !!id))];
    const rows = await db.query.githubInstallations.findMany({
      where: ids.length
        ? or(inArray(githubInstallations.id, ids), eq(githubInstallations.installedByUserId, userId))
        : eq(githubInstallations.installedByUserId, userId),
      columns: { id: true, installedByUserId: true },
    });
    const access = await Promise.all(rows.map((row) => getInstallationAccessForUser(userId, row)));
    return rows.filter((_, i) => access[i].canManage && access[i].otherTeamsUsingIt.length === 0).map((row) => row.id);
  } catch (e) {
    console.error('Settings: GitHub installation access error:', e);
    return [];
  }
}
