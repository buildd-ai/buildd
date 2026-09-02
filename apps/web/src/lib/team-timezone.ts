import { db } from '@buildd/core/db';
import { teams, users, workspaces, teamMembers } from '@buildd/core/db/schema';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { DEFAULT_TIMEZONE, isValidTimezone, resolveTimezone } from '@buildd/core/timezone';

/**
 * Timezone lookups. Two stored zones, no override chain — see
 * `packages/core/timezone.ts` for the model.
 *
 * Every function here resolves to a usable IANA zone and never throws: these are
 * called from best-effort renderers (the PR activity comment, notification bodies)
 * where a DB hiccup must degrade to UTC, not abort the surrounding step.
 */

/** The team's canonical working zone, or UTC. */
export async function getTeamTimezone(teamId: string | null | undefined): Promise<string> {
  if (!teamId) return DEFAULT_TIMEZONE;
  try {
    const team = await db.query.teams.findFirst({
      where: eq(teams.id, teamId),
      columns: { timezone: true },
    });
    return resolveTimezone(team?.timezone);
  } catch {
    return DEFAULT_TIMEZONE;
  }
}

/**
 * The zone for a shared artifact belonging to a workspace (PR comments, schedule
 * defaults). Workspaces have no zone of their own — this resolves through to the
 * owning team.
 */
export async function getWorkspaceTimezone(workspaceId: string | null | undefined): Promise<string> {
  if (!workspaceId) return DEFAULT_TIMEZONE;
  try {
    const ws = await db.query.workspaces.findFirst({
      where: eq(workspaces.id, workspaceId),
      columns: { teamId: true },
    });
    return getTeamTimezone(ws?.teamId);
  } catch {
    return DEFAULT_TIMEZONE;
  }
}

/**
 * The zone to render in for one known signed-in person: their own detected zone
 * first, then their team's, then UTC.
 */
export async function getViewerTimezone(
  userId: string | null | undefined,
  teamId?: string | null,
): Promise<string> {
  if (!userId) return getTeamTimezone(teamId);
  try {
    const user = await db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: { timezone: true },
    });
    if (isValidTimezone(user?.timezone)) return user.timezone;
  } catch {
    // fall through to the team zone
  }
  return getTeamTimezone(teamId);
}

/**
 * Persist a zone detected from this user's browser, and seed it onto any team
 * they OWN that has no zone yet.
 *
 * Owner-only seeding is deliberate: the first member to sign in may be a
 * contractor in another country, and their zone must not silently become the
 * team's. The seeding UPDATE carries `timezone IS NULL`, so it can never
 * overwrite a zone an admin chose — it is safe to call on every page load.
 *
 * Returns null when `timezone` is not a zone this runtime recognises.
 */
export async function recordUserTimezone(
  userId: string,
  timezone: string,
): Promise<{ timezone: string; seededTeamIds: string[] } | null> {
  if (!isValidTimezone(timezone)) return null;

  await db.update(users).set({ timezone, updatedAt: new Date() }).where(eq(users.id, userId));

  const owned = await db
    .select({ teamId: teamMembers.teamId })
    .from(teamMembers)
    .where(and(eq(teamMembers.userId, userId), eq(teamMembers.role, 'owner')));

  if (owned.length === 0) return { timezone, seededTeamIds: [] };

  const seeded = await db
    .update(teams)
    .set({ timezone, updatedAt: new Date() })
    .where(
      and(
        inArray(
          teams.id,
          owned.map((o) => o.teamId),
        ),
        isNull(teams.timezone),
      ),
    )
    .returning({ id: teams.id });

  return { timezone, seededTeamIds: seeded.map((t) => t.id) };
}
