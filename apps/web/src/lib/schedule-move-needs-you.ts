/**
 * Open schedule move proposals as Needs You cards (docs/specs/workspace-routing-and-reach.md §6, D-2).
 *
 * A run of a schedule proposed that the schedule start in another workspace
 * (`propose_schedule_move`), or its repeated refusals proposed it
 * (lib/schedule-move.ts). Only someone who holds `delegate_schedule_access`
 * sees the card, since nobody else can answer it. Re-derived on every build
 * from the open rows (queue freshness rule, lib/action-queue.ts): an answered
 * proposal is no longer open and drops out. A pure read; an unanswered
 * proposal never blocks a run.
 */
import type { WaitingOnYouRawItem, ScheduleMoveCard } from './action-queue';

export const scheduleMoveHref = (workspaceId: string) => `/app/workspaces/${workspaceId}/schedules`;

/** Pure. One Needs You item per open proposal. */
export function scheduleMoveNeedsYouItems(rows: readonly ScheduleMoveCard[]): WaitingOnYouRawItem[] {
  const seen = new Set<string>();
  const items: WaitingOnYouRawItem[] = [];
  for (const m of rows) {
    if (seen.has(m.proposalId)) continue;
    seen.add(m.proposalId);
    items.push({
      kind: 'schedule_move',
      scheduleMove: m,
      workspaceId: m.fromWorkspaceId,
      workspaceName: m.fromWorkspaceName,
      fixHref: scheduleMoveHref(m.fromWorkspaceId),
      fixLabel: 'Review',
    });
  }
  return items;
}

/**
 * Home's read as one statement for its batch: open proposals for schedules
 * homed in these workspaces, newest first, at most 25, with the schedule and
 * both workspaces' names. Only a viewer who can answer them asks. `query` is
 * un-run, for `readRound`.
 */
export async function scheduleMoveNeedsYouRead(workspaceIds: readonly string[]) {
  const [{ db }, { scheduleMoves, taskSchedules, workspaces }, { and, desc, eq, inArray }, { alias }] = await Promise.all([
    import('@buildd/core/db'), import('@buildd/core/db/schema'), import('drizzle-orm'), import('drizzle-orm/pg-core'),
  ]);
  const from = alias(workspaces, 'move_from');
  const to = alias(workspaces, 'move_to');
  const query = db.select({
    proposalId: scheduleMoves.id, scheduleId: scheduleMoves.scheduleId, scheduleName: taskSchedules.name,
    fromWorkspaceId: scheduleMoves.fromWorkspaceId, fromWorkspaceName: from.name,
    toWorkspaceId: scheduleMoves.toWorkspaceId, toWorkspaceName: to.name,
    reason: scheduleMoves.reason, origin: scheduleMoves.origin,
  })
    .from(scheduleMoves)
    .innerJoin(taskSchedules, eq(taskSchedules.id, scheduleMoves.scheduleId))
    .innerJoin(from, eq(from.id, scheduleMoves.fromWorkspaceId))
    .innerJoin(to, eq(to.id, scheduleMoves.toWorkspaceId))
    .where(and(eq(scheduleMoves.status, 'open'), inArray(scheduleMoves.fromWorkspaceId, [...workspaceIds])))
    .orderBy(desc(scheduleMoves.createdAt))
    .limit(25);
  type Row = Awaited<typeof query>[number];
  return {
    query,
    // An open row is never a direct move; the narrowing is for the type.
    items: (rows: readonly Row[]): WaitingOnYouRawItem[] => scheduleMoveNeedsYouItems(rows.map(r => ({ ...r, origin: r.origin === 'auto' ? 'auto' as const : 'task' as const }))),
  };
}
