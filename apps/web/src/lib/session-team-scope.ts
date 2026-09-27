import { getTeamWorkspaceIds, getUserTeamIds } from '@/lib/team-access';

/**
 * Team scope for a dashboard-session read of a team-scoped route.
 *
 * A session user may belong to several teams. By default the scope is all of
 * them; `pinTeamId` narrows it to exactly one — the in-app chat runs inside one
 * team's conversation and must not see another team's rows. A pin outside the
 * user's teams returns null, which callers answer with 404 (never "exists but
 * not yours").
 */
export async function resolveSessionTeamIds(
  userId: string,
  pinTeamId: string | null | undefined,
): Promise<string[] | null> {
  const teamIds = await getUserTeamIds(userId);
  if (!pinTeamId) return teamIds;
  return teamIds.includes(pinTeamId) ? [pinTeamId] : null;
}

/** Every workspace owned by one of `teamIds`, deduped. */
export async function workspaceIdsForTeams(teamIds: string[]): Promise<string[]> {
  const lists = await Promise.all(teamIds.map((teamId) => getTeamWorkspaceIds(teamId)));
  return [...new Set(lists.flat())];
}
