import { db } from '@buildd/core/db';
import { missions } from '@buildd/core/db/schema';
import { and, eq, sql } from 'drizzle-orm';
import { isUuid } from '@/lib/uuid';
import { sqlWhere } from '@buildd/core/db/relational-sql';

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
    where: sqlWhere(eq(missions.id, missionId)),
    columns: { teamId: true },
  });
  return !!mission && mission.teamId === teamId;
}

export type MissionIdResolution =
  | { ok: true; id: string }
  | { ok: false; status: 400 | 404; error: string };

/**
 * Turn the missionId a caller sent into a full mission UUID. A full UUID
 * passes through untouched; a hex prefix (the short id people cite) resolves
 * when exactly one mission on the team starts with it. Anything else is a 4xx
 * naming the value — never a malformed uuid reaching Postgres (a 500).
 */
export async function resolveMissionId(
  input: string,
  teamId: string | null | undefined,
): Promise<MissionIdResolution> {
  const raw = String(input);
  if (isUuid(raw as unknown)) return { ok: true, id: raw };
  if (!/^[0-9a-f]{4,35}$/i.test(raw)) {
    return {
      ok: false,
      status: 400,
      error: `missionId "${input}" is not a mission id: send the full mission UUID or a unique id prefix of at least 4 hex characters.`,
    };
  }
  if (!teamId) return { ok: false, status: 404, error: `Mission not found: no mission matches "${input}".` };
  const rows = await db.query.missions.findMany({
    where: sqlWhere(and(eq(missions.teamId, teamId), sql`${missions.id}::text like ${raw.toLowerCase() + '%'}`)),
    columns: { id: true },
    limit: 2,
  });
  if (rows.length === 0) return { ok: false, status: 404, error: `Mission not found: no mission on your team matches "${input}".` };
  if (rows.length > 1) {
    return { ok: false, status: 400, error: `missionId "${input}" matches more than one mission: send the full mission UUID.` };
  }
  return { ok: true, id: rows[0].id };
}
