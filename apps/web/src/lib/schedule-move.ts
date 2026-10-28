/**
 * Moving a schedule's home (docs/specs/workspace-routing-and-reach.md §6).
 *
 * A task a schedule spawned may *propose* that the schedule's future runs
 * start in another workspace; only a person with `delegate_schedule_access`
 * accepts it. Every move, through a proposal or the schedule PATCH, goes
 * through `validateScheduleMove` and `applyScheduleMove`, and is recorded as a
 * `schedule_moves` row, which is the schedule's move history.
 *
 *  - An open proposal never blocks a run: the schedule keeps its home until
 *    someone accepts.
 *  - Accepting changes the schedule row only. The run in flight and the tasks
 *    already filed keep their home; the next tick files in the new one.
 *  - The delegation is re-evaluated on a move: a grant naming the new home is
 *    dropped (it is home now), and "accept + read grant" keeps the old home
 *    readable.
 *
 * No `db.transaction()` (neon-http): each step is an atomic UPDATE...WHERE.
 */
import { db } from '@buildd/core/db';
import { scheduleMoves, scheduleRefusals, taskSchedules, tasks, workspaces } from '@buildd/core/db/schema';
import { and, count, desc, eq, gt } from 'drizzle-orm';
import { readScheduleDelegation, type ScheduleDelegation, type ScheduleDelegationGrant } from '@buildd/core/token-delegation';
import { clearCallerCache, callerDep } from './caller-cache';
import { isUuid } from '@/lib/uuid';

/** Runs refused on one workspace before the move is proposed automatically (I-29). */
export const AUTO_PROPOSE_AFTER_REFUSALS = 2;
/** Refusals older than this no longer count toward an automatic proposal. */
const REFUSAL_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
export const MOVE_REASON_MAX = 1000;

export type ScheduleMoveRow = typeof scheduleMoves.$inferSelect;
type ScheduleRow = typeof taskSchedules.$inferSelect;

export type MoveCheck =
  | { ok: true; teamId: string }
  | { ok: false; status: 400 | 403 | 404; error: string };

/**
 * Validate a move of a schedule currently homed in `fromWorkspaceId` to
 * `targetWorkspaceId`: the target exists, is in the schedule's team, and the
 * mover can create tasks there (`canCreateIn`, supplied by the caller because
 * a person's reach and an API key's reach are decided differently). Nothing is
 * written. Workspaces carry no archived state today; when they do, refuse it here.
 */
export async function validateScheduleMove(input: {
  fromWorkspaceId: string;
  targetWorkspaceId: string;
  canCreateIn: (workspaceId: string) => Promise<boolean>;
}): Promise<MoveCheck> {
  const { fromWorkspaceId, targetWorkspaceId, canCreateIn } = input;
  if (!isUuid(targetWorkspaceId)) {
    return { ok: false, status: 400, error: 'workspace must be a workspace id' };
  }
  const [own] = await db.select({ teamId: workspaces.teamId }).from(workspaces).where(eq(workspaces.id, fromWorkspaceId)).limit(1);
  if (!own) return { ok: false, status: 404, error: 'Workspace not found' };
  const [target] = await db.select({ teamId: workspaces.teamId }).from(workspaces).where(eq(workspaces.id, targetWorkspaceId)).limit(1);
  // A workspace of another team reads as absent, so its existence is not revealed.
  if (!target || target.teamId !== own.teamId) return { ok: false, status: 404, error: 'Target workspace not found' };
  if (targetWorkspaceId === fromWorkspaceId) return { ok: false, status: 400, error: 'The schedule is already in that workspace' };
  if (!(await canCreateIn(targetWorkspaceId))) {
    return { ok: false, status: 403, error: 'You cannot create tasks in the target workspace' };
  }
  return { ok: true, teamId: own.teamId };
}

/**
 * The delegation after a move: grants naming the new home go (it is home now),
 * and `grantOldHome` adds a read grant on the old one. Pure.
 */
export function delegationAfterMove(
  current: unknown,
  move: { from: string; to: string; grantOldHome: boolean },
  stamp: { userId: string | null; accountId: string | null; now?: Date },
): ScheduleDelegation | null {
  const grants: ScheduleDelegationGrant[] = readScheduleDelegation(current).filter(g => g.workspaceId !== move.to);
  if (move.grantOldHome) {
    const existing = grants.find(g => g.workspaceId === move.from);
    if (existing) {
      if (!existing.capabilities.includes('analytics:read')) existing.capabilities = [...existing.capabilities, 'analytics:read'];
    } else {
      grants.push({ workspaceId: move.from, capabilities: ['analytics:read'] });
    }
  }
  if (grants.length === 0) return null;
  const prev = current as Partial<ScheduleDelegation> | null;
  // Grants that stay keep their original granter; only a new read grant is this person's.
  const changed = move.grantOldHome;
  return {
    grants,
    grantedByUserId: changed ? stamp.userId : prev?.grantedByUserId ?? null,
    grantedByAccountId: changed ? stamp.accountId : prev?.grantedByAccountId ?? null,
    grantedAt: changed ? (stamp.now ?? new Date()).toISOString() : prev?.grantedAt ?? (stamp.now ?? new Date()).toISOString(),
  };
}

export interface MoveActor { userId: string | null; accountId: string | null }

/**
 * Move the schedule in one write and record it. Optimistic on the home it was
 * read in, so a concurrent move loses cleanly (returns null). A proposal row,
 * when given, becomes the history row; otherwise a `direct` row is written.
 */
export async function applyScheduleMove(input: {
  schedule: Pick<ScheduleRow, 'id' | 'workspaceId' | 'delegation'>;
  targetWorkspaceId: string;
  actor: MoveActor;
  grantOldHome?: boolean;
  reason?: string | null;
  proposalId?: string;
}): Promise<{ schedule: ScheduleRow; move: ScheduleMoveRow } | null> {
  const { schedule, targetWorkspaceId, actor } = input;
  const from = schedule.workspaceId;
  if (!from) return null;
  const now = new Date();
  const delegation = delegationAfterMove(schedule.delegation, { from, to: targetWorkspaceId, grantOldHome: !!input.grantOldHome }, { ...actor, now });
  const [updated] = await db.update(taskSchedules)
    .set({ workspaceId: targetWorkspaceId, delegation, updatedAt: now })
    .where(and(eq(taskSchedules.id, schedule.id), eq(taskSchedules.workspaceId, from)))
    .returning();
  if (!updated) return null;

  const decided = { status: 'accepted' as const, decidedByUserId: actor.userId, decidedByAccountId: actor.accountId, decidedAt: now, grantedOldHome: !!input.grantOldHome };
  let move: ScheduleMoveRow | undefined;
  if (input.proposalId) {
    [move] = await db.update(scheduleMoves).set(decided).where(eq(scheduleMoves.id, input.proposalId)).returning();
  }
  if (!move) {
    [move] = await db.insert(scheduleMoves).values({
      scheduleId: schedule.id, fromWorkspaceId: from, toWorkspaceId: targetWorkspaceId,
      origin: 'direct', reason: input.reason ?? null, ...decided,
    }).returning();
  }
  // Any other open proposal was about the old home; it is answered by this move.
  await db.update(scheduleMoves).set({ status: 'replaced', decidedAt: now })
    .where(and(eq(scheduleMoves.scheduleId, schedule.id), eq(scheduleMoves.status, 'open')));
  // Task tokens read the schedule's delegation through the caller cache.
  await clearCallerCache(...[from, targetWorkspaceId].map(callerDep.workspaceSchedules));
  return { schedule: updated, move: move! };
}

/** The schedule's open proposal, if any. */
export async function getOpenMoveProposal(scheduleId: string): Promise<ScheduleMoveRow | null> {
  const [row] = await db.select().from(scheduleMoves)
    .where(and(eq(scheduleMoves.scheduleId, scheduleId), eq(scheduleMoves.status, 'open'))).limit(1);
  return row ?? null;
}

/** Newest first: proposals and moves of one schedule. */
export async function listScheduleMoves(scheduleId: string, limit = 20): Promise<ScheduleMoveRow[]> {
  return db.select().from(scheduleMoves).where(eq(scheduleMoves.scheduleId, scheduleId))
    .orderBy(desc(scheduleMoves.createdAt)).limit(limit);
}

/**
 * Record the one open proposal for a schedule; a newer one replaces the older.
 * Changes nothing else (I-23).
 */
export async function recordMoveProposal(input: {
  schedule: Pick<ScheduleRow, 'id' | 'workspaceId'>;
  targetWorkspaceId: string;
  reason: string;
  origin: 'task' | 'auto';
  taskId: string | null;
  evidence?: ScheduleMoveRow['evidence'];
}): Promise<ScheduleMoveRow> {
  const from = input.schedule.workspaceId!;
  for (let attempt = 0; ; attempt++) {
    await db.update(scheduleMoves).set({ status: 'replaced', decidedAt: new Date() })
      .where(and(eq(scheduleMoves.scheduleId, input.schedule.id), eq(scheduleMoves.status, 'open')));
    try {
      const [row] = await db.insert(scheduleMoves).values({
        scheduleId: input.schedule.id, fromWorkspaceId: from, toWorkspaceId: input.targetWorkspaceId,
        origin: input.origin, status: 'open', reason: input.reason.slice(0, MOVE_REASON_MAX),
        proposedByTaskId: input.taskId, evidence: input.evidence ?? null,
      }).returning();
      return row;
    } catch (err) {
      // A concurrent proposal took the one open slot: replace it once and retry.
      if (attempt >= 1 || (err as { code?: string })?.code !== '23505') throw err;
    }
  }
}

/** A person declined: the schedule stays where it is. Null when the proposal is no longer open. */
export async function keepScheduleHome(proposalId: string, actor: MoveActor): Promise<ScheduleMoveRow | null> {
  const [row] = await db.update(scheduleMoves)
    .set({ status: 'kept', decidedByUserId: actor.userId, decidedByAccountId: actor.accountId, decidedAt: new Date() })
    .where(and(eq(scheduleMoves.id, proposalId), eq(scheduleMoves.status, 'open'))).returning();
  return row ?? null;
}

/**
 * A schedule-spawned task was refused on another workspace of its team (FORBIDDEN
 * on a delegated read, or `delegation_required` on a filing). Two runs refused
 * on the same workspace propose the move themselves (I-29); a person still
 * accepts it. Best effort: never throws, never changes the response.
 */
export async function noteScheduleRefusal(
  account: { teamId?: string | null; taskScope?: { taskId: string; workspaceId: string } },
  workspaceId: string,
  capability: 'analytics:read' | 'tasks:create',
): Promise<void> {
  try {
    const scope = account.taskScope;
    if (!scope || !workspaceId || workspaceId === scope.workspaceId) return;
    const [task] = await db.select({ scheduleId: tasks.scheduleId }).from(tasks).where(eq(tasks.id, scope.taskId)).limit(1);
    if (!task?.scheduleId) return;
    const [schedule] = await db.select().from(taskSchedules).where(eq(taskSchedules.id, task.scheduleId)).limit(1);
    if (!schedule?.workspaceId || schedule.workspaceId !== scope.workspaceId) return;
    const [target] = await db.select({ teamId: workspaces.teamId }).from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
    if (!target || !account.teamId || target.teamId !== account.teamId) return;

    await db.insert(scheduleRefusals)
      .values({ scheduleId: schedule.id, workspaceId, taskId: scope.taskId, capability })
      .onConflictDoNothing();

    // Count only refusals since a person last kept the home against this target.
    const [lastKeep] = await db.select({ at: scheduleMoves.decidedAt }).from(scheduleMoves)
      .where(and(eq(scheduleMoves.scheduleId, schedule.id), eq(scheduleMoves.toWorkspaceId, workspaceId), eq(scheduleMoves.status, 'kept')))
      .orderBy(desc(scheduleMoves.decidedAt)).limit(1);
    const since = new Date(Math.max(Date.now() - REFUSAL_WINDOW_MS, lastKeep?.at?.getTime() ?? 0));
    const [{ n }] = await db.select({ n: count() }).from(scheduleRefusals)
      .where(and(eq(scheduleRefusals.scheduleId, schedule.id), eq(scheduleRefusals.workspaceId, workspaceId), gt(scheduleRefusals.createdAt, since)));
    if (n < AUTO_PROPOSE_AFTER_REFUSALS) return;

    const open = await getOpenMoveProposal(schedule.id);
    if (open?.toWorkspaceId === workspaceId) return;
    const refusals = await db.select().from(scheduleRefusals)
      .where(and(eq(scheduleRefusals.scheduleId, schedule.id), eq(scheduleRefusals.workspaceId, workspaceId), gt(scheduleRefusals.createdAt, since)))
      .orderBy(desc(scheduleRefusals.createdAt)).limit(10);
    await recordMoveProposal({
      schedule, targetWorkspaceId: workspaceId, origin: 'auto', taskId: null,
      reason: `${n} runs of this schedule were refused on that workspace (${[...new Set(refusals.map(r => r.capability))].join(', ')}).`,
      evidence: { refusals: refusals.map(r => ({ taskId: r.taskId, capability: r.capability, at: r.createdAt.toISOString() })) },
    });
  } catch (err) {
    console.warn('[schedule-move] refusal note failed (non-fatal):', (err as Error)?.message ?? err);
  }
}
