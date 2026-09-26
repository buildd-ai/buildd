import { db } from '@buildd/core/db';
import { missions } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';

/**
 * May a task owned by `teamId` be linked to `missionId`? Only when the mission
 * exists and belongs to that team. Missing and foreign missions both answer
 * false, and callers return the same 404 for each.
 *
 * The team comparison is done in JS rather than in the WHERE so route tests
 * that mock `db` can observe it.
 */
export async function isMissionLinkable(
  missionId: unknown,
  teamId: string | null | undefined,
): Promise<boolean> {
  if (typeof missionId !== 'string' || missionId.length === 0) return false;
  if (!teamId) return false;
  const mission = await db.query.missions.findFirst({
    where: eq(missions.id, missionId),
    columns: { teamId: true },
  });
  return !!mission && mission.teamId === teamId;
}
