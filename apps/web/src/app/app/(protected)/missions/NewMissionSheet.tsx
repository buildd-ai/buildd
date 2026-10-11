import { db } from '@buildd/core/db';
import { workspaces, workspaceSkills } from '@buildd/core/db/schema';
import { inArray, desc, eq, and } from 'drizzle-orm';
import { isSystemWorkspace } from '@buildd/shared';
import { getUserWorkspaceIds } from '@/lib/team-access';
import UrlSheet from '@/components/UrlSheet';
import NewMissionForm from './NewMissionForm';

/**
 * The params that open the sheet and prefill it; closing drops them all.
 * `workspace` stays: on Missions it is also the list's filter.
 */
export const NEW_MISSION_KEYS = ['new', 'artifactId', 'artifactTitle', 'sourceMission', 'initiative'] as const;

/**
 * New mission, a sheet over Missions at `?new=1` (was /app/missions/new, which
 * redirects here with its query, so `?workspace=` and `?artifactId=` prefills
 * still apply). New missions default to the active team.
 */
export default async function NewMissionSheet({ userId, teamId }: { userId: string; teamId: string }) {
  const wsIds = await getUserWorkspaceIds(userId);

  const [teamWorkspaces, roles] = wsIds.length === 0
    ? [[], []]
    : await Promise.all([
      db.query.workspaces.findMany({
        where: inArray(workspaces.id, wsIds),
        columns: { id: true, name: true },
        orderBy: [desc(workspaces.createdAt)],
      }),
      // Enabled roles across the user's workspaces.
      db.query.workspaceSkills.findMany({
        where: and(inArray(workspaceSkills.workspaceId, wsIds), eq(workspaceSkills.enabled, true)),
        columns: { slug: true, name: true, color: true, workspaceId: true },
        orderBy: [desc(workspaceSkills.createdAt)],
      }),
    ]);

  return (
    <UrlSheet title="New mission" keys={NEW_MISSION_KEYS} height="tall" testId="new-mission-sheet">
      <NewMissionForm
        workspaces={teamWorkspaces.filter(ws => !isSystemWorkspace(ws.name))}
        roles={roles}
        teamId={teamId}
      />
    </UrlSheet>
  );
}
