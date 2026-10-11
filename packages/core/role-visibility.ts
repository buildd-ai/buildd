/**
 * Which role rows a task may run under — the one rule every role-slug lookup
 * applies, so a personal role cannot leak through a site that forgot it.
 *
 * A role row is one of:
 *   - a workspace override (`workspaceId` set, `ownerUserId` NULL);
 *   - a team default (`workspaceId` NULL, `ownerUserId` NULL);
 *   - a personal role (`ownerUserId` set, always team-level). `visibility`
 *     'private' = usable only on tasks whose requester is its owner
 *     (`resolveTaskRequesterUserId`); 'team' = shared, anyone in the team.
 *
 * Candidate rows for a task = the team's rows that are an override for the
 * task's workspace, a team default, or a personal row that is shared or owned
 * by the requester. For one slug the winner is, in order:
 *   1. the workspace override
 *   2. the requester's own personal row
 *   3. a shared personal row (lowest id wins between two owners — never an
 *      unordered `LIMIT 1`)
 *   4. the team default
 *
 * Pure apart from the SQL builders: no DB access.
 */
import { and, eq, isNull, or, type SQL } from 'drizzle-orm';
import { workspaceSkills } from './db/schema';

export interface VisibleRoleRow {
  slug: string;
  workspaceId: string | null;
  teamId: string;
  ownerUserId: string | null;
  visibility: string;
  id?: string;
}

/** See `roleRowRank`: the rows came from a query already filtered to one team. */
export const TEAM_SCOPED_BY_QUERY = Symbol('team-scoped-by-query');

export interface RoleVisibilityContext {
  teamId: string | null | undefined | typeof TEAM_SCOPED_BY_QUERY;
  workspaceId: string;
  /** Who the task is for; null = no person (team and shared roles only). */
  requesterUserId: string | null;
}

/** Columns a role lookup must select for `pickVisibleRoleRow` to decide. */
export const ROLE_VISIBILITY_COLUMNS = {
  id: true,
  slug: true,
  workspaceId: true,
  teamId: true,
  ownerUserId: true,
  visibility: true,
} as const;

/** The owner/visibility half of the rule: team row, shared, or the requester's own. */
export function personalRoleVisibleSql(requesterUserId: string | null): SQL {
  return or(
    isNull(workspaceSkills.ownerUserId),
    eq(workspaceSkills.visibility, 'team'),
    ...(requesterUserId ? [eq(workspaceSkills.ownerUserId, requesterUserId)] : []),
  )!;
}

/**
 * WHERE predicate for every role row a task in `workspaceId` may run under.
 * AND it with the slug / isRole / enabled filters a site needs, then pick the
 * winner per slug with `pickVisibleRoleRow` / `effectiveVisibleRoles`.
 */
export function roleRowsVisibleTo(ctx: { teamId: string; workspaceId: string; requesterUserId: string | null }): SQL {
  return and(
    eq(workspaceSkills.teamId, ctx.teamId),
    or(isNull(workspaceSkills.workspaceId), eq(workspaceSkills.workspaceId, ctx.workspaceId)),
    personalRoleVisibleSql(ctx.requesterUserId),
  )!;
}

/**
 * Scope predicate without the per-person filter, for a lookup whose requester
 * is not known yet (claim batches). Rows it returns MUST go through
 * `pickVisibleRoleRow` with the requester before use.
 */
export function roleRowsInScope(ctx: { teamId: string; workspaceId: string }): SQL {
  return and(
    eq(workspaceSkills.teamId, ctx.teamId),
    or(isNull(workspaceSkills.workspaceId), eq(workspaceSkills.workspaceId, ctx.workspaceId)),
  )!;
}

/**
 * 0 = override … 3 = team default; null = not visible to this task.
 * `ctx.teamId === TEAM_SCOPED_BY_QUERY` says the query already limited rows to
 * the task's team, so membership is not re-checked; a missing team (null or
 * undefined) means no team-level row qualifies.
 */
export function roleRowRank(
  row: Pick<VisibleRoleRow, 'workspaceId' | 'ownerUserId' | 'visibility'> & { teamId?: string | null },
  ctx: RoleVisibilityContext,
): number | null {
  // `ownerUserId` is a required field of VisibleRoleRow, so a lookup that
  // forgot to select it fails to type-check; the loose `== null` only spares
  // hand-written fixtures from spelling out `ownerUserId: null`.
  if (row.workspaceId != null) {
    if (row.workspaceId !== ctx.workspaceId || row.ownerUserId != null) return null;
    return 0;
  }
  if (ctx.teamId !== TEAM_SCOPED_BY_QUERY && (!ctx.teamId || row.teamId !== ctx.teamId)) return null;
  if (row.ownerUserId == null) return 3;
  if (ctx.requesterUserId && row.ownerUserId === ctx.requesterUserId) return 1;
  if (row.visibility === 'team') return 2;
  return null;
}

export function isRoleRowVisibleTo(row: VisibleRoleRow, ctx: RoleVisibilityContext): boolean {
  return roleRowRank(row, ctx) !== null;
}

function better(a: VisibleRoleRow, aRank: number, b: VisibleRoleRow, bRank: number): boolean {
  if (aRank !== bRank) return aRank < bRank;
  return (a.id ?? '') < (b.id ?? '');
}

/** The row a task runs under for `slug`, or null when none is visible to it. */
export function pickVisibleRoleRow<R extends VisibleRoleRow>(
  rows: readonly R[],
  slug: string | null | undefined,
  ctx: RoleVisibilityContext,
): R | null {
  if (!slug) return null;
  let best: R | null = null;
  let bestRank = Infinity;
  for (const row of rows) {
    if (row.slug !== slug) continue;
    const rank = roleRowRank(row, ctx);
    if (rank === null) continue;
    if (!best || better(row, rank, best, bestRank)) {
      best = row;
      bestRank = rank;
    }
  }
  return best;
}

/** One winning row per slug — the role list a task in this context can see. */
export function effectiveVisibleRoles<R extends VisibleRoleRow>(
  rows: readonly R[],
  ctx: RoleVisibilityContext,
): R[] {
  const best = new Map<string, { row: R; rank: number }>();
  for (const row of rows) {
    const rank = roleRowRank(row, ctx);
    if (rank === null) continue;
    const cur = best.get(row.slug);
    if (!cur || better(row, rank, cur.row, cur.rank)) best.set(row.slug, { row, rank });
  }
  return [...best.values()].map(v => v.row);
}

/** True when the winner for `slug` can depend on who the task is for. */
export function slugHasPersonalRows(rows: readonly VisibleRoleRow[], slug: string | null | undefined): boolean {
  return !!slug && rows.some(r => r.slug === slug && r.ownerUserId != null);
}

/**
 * `pickVisibleRoleRow` with a lazily-resolved requester: the requester walk
 * (task → parents → mission → schedule) runs only when a personal row for the
 * slug is among `rows`, which for almost every task it is not.
 */
export async function pickVisibleRoleRowLazy<R extends VisibleRoleRow>(
  rows: readonly R[],
  slug: string | null | undefined,
  ctx: Omit<RoleVisibilityContext, 'requesterUserId'>,
  requester: () => Promise<string | null>,
): Promise<R | null> {
  const requesterUserId = slugHasPersonalRows(rows, slug) ? await requester() : null;
  return pickVisibleRoleRow(rows, slug, { ...ctx, requesterUserId });
}

/**
 * A requester thunk for `pickVisibleRoleRowLazy`: `requesterOf(task)`
 * (memoized per task object), or null with no task. task-requester is loaded
 * on first use, so a module that only ever sees team roles never pulls in the
 * task/mission/schedule tables.
 */
export function lazyRequester(task: object | null | undefined): () => Promise<string | null> {
  return async () => {
    if (!task) return null;
    const { requesterOf } = await import('./task-requester');
    return requesterOf(task as Parameters<typeof requesterOf>[0]);
  };
}
