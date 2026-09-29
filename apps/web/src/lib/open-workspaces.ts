/**
 * "Open" means open within the owning team (`workspaces.teamId`), never across
 * teams. Every read that treats a workspace's `accessMode: 'open'` as a grant
 * goes through this module, so the team predicate cannot be forgotten at one
 * site and remembered at another.
 *
 * - `openInTeams` / `listOpenWorkspaces`: the SQL form, for listing.
 * - `isOpenWithinTeams`: the row form, for a workspace already loaded.
 * - `workspaceOpenToCaller`: the per-id form used by resources that hang off
 *   a workspace (missions, initiatives). Another team's open workspace counts
 *   only for an API account explicitly linked to it, which is the one way that
 *   team's admins grant outside access (see `workspace-reach.ts`).
 *
 * There is deliberately no platform-wide "all open workspaces" helper and no
 * platform-wide cache of one.
 */
import { db } from '@buildd/core/db';
import { workspaces, accountWorkspaces } from '@buildd/core/db/schema';
import { and, eq, inArray } from 'drizzle-orm';

/**
 * WHERE predicate: open workspaces owned by one of `teamIds`. Callers with no
 * teams must not query at all (`listOpenWorkspaces` handles that); an empty
 * list here is a programming error rather than a silent "match everything".
 */
export function openInTeams(teamIds: readonly string[]) {
  if (teamIds.length === 0) throw new Error('openInTeams: teamIds must not be empty');
  return and(eq(workspaces.accessMode, 'open'), inArray(workspaces.teamId, [...teamIds]));
}

type WorkspaceRowOf<C extends Record<string, true>> = { [K in keyof C & keyof typeof workspaces.$inferSelect]: (typeof workspaces.$inferSelect)[K] };

/** Open workspaces of the given teams. No teams, no query, no rows. */
export async function listOpenWorkspaces<C extends Record<string, true>>(
  teamIds: readonly string[],
  columns: C,
  opts: { limit?: number } = {},
): Promise<WorkspaceRowOf<C>[]> {
  const ids = [...new Set(teamIds.filter(Boolean))];
  if (ids.length === 0) return [];
  const rows = await db.query.workspaces.findMany({
    where: openInTeams(ids),
    columns: columns as never,
    ...(opts.limit ? { limit: opts.limit } : {}),
  });
  return rows as unknown as WorkspaceRowOf<C>[];
}

/** A loaded workspace row: is it open to members of these teams? */
export function isOpenWithinTeams(
  ws: { teamId: string | null | undefined; accessMode: string | null | undefined } | null | undefined,
  teamIds: readonly string[],
): boolean {
  return !!ws && ws.accessMode === 'open' && !!ws.teamId && teamIds.includes(ws.teamId);
}

/**
 * Does the workspace's open mode let this caller in? True only when the
 * workspace is open AND either belongs to one of the caller's teams or the
 * caller is an API account with an explicit link to it. A restricted workspace
 * is never granted here: that is the caller's team check or link check to make.
 */
export async function workspaceOpenToCaller(
  workspaceId: string | null | undefined,
  caller: { teamIds: readonly string[]; accountId?: string | null },
): Promise<boolean> {
  if (!workspaceId) return false;
  const ws = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, workspaceId),
    columns: { teamId: true, accessMode: true },
  });
  if (!ws || ws.accessMode !== 'open') return false;
  if (isOpenWithinTeams(ws, caller.teamIds)) return true;
  if (!caller.accountId) return false;
  const link = await db.query.accountWorkspaces.findFirst({
    where: and(
      eq(accountWorkspaces.accountId, caller.accountId),
      eq(accountWorkspaces.workspaceId, workspaceId),
    ),
    columns: { workspaceId: true },
  });
  return !!link;
}
