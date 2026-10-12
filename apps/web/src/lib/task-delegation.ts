/**
 * Task delegation: the db half (rules: packages/core/token-delegation.ts).
 * The person and claim checks and the writes are in task-delegation-checks.ts:
 * this module is imported by token auth, so it stays free of team access and
 * of drizzle helpers (callback `where` only).
 *
 * A per-task token reaches its own task's workspace, plus whatever its
 * delegations grant: the schedule that spawned the task, and the task's own
 * `tasks.delegation`. This module is the one place both are read, so the token
 * (task-token-auth.ts) and the claim pre-flight (claim/delegation-gate.ts) can
 * never disagree about what a run may reach.
 *
 * Writes: a person who reaches each target sets a task's delegation (create or
 * update before claim); a person approving the task's `tasks:create` capability
 * request adds one grant to it. Nothing reads a grant from task context.
 */
import { db } from '@buildd/core/db';
import { tokenWorkspaceAllowed } from '@buildd/core/token-scopes';
import { mergeDelegationGrants, readScheduleDelegation, type ScheduleDelegationGrant } from '@buildd/core/token-delegation';

interface DelegatedTaskRow {
  id: string;
  workspaceId: string;
  scheduleId?: string | null;
  delegation?: unknown;
}

/**
 * Every grant a task's token would carry, before any narrowing: its schedule's
 * delegation (only a schedule of the task's own workspace counts) and its own.
 */
export async function loadRawTaskGrants(task: DelegatedTaskRow): Promise<ScheduleDelegationGrant[]> {
  let grants = readScheduleDelegation(task.delegation);
  if (task.scheduleId) {
    const schedule = await db.query.taskSchedules.findFirst({
      where: (s, { eq: eqOp }) => eqOp(s.id, task.scheduleId!),
      columns: { workspaceId: true, delegation: true },
    });
    if (schedule && schedule.workspaceId === task.workspaceId) {
      grants = mergeDelegationGrants(readScheduleDelegation(schedule.delegation), grants).grants;
    }
  }
  return grants;
}

export async function teamsOf(ids: string[]): Promise<Map<string, string | null>> {
  if (!ids.length) return new Map();
  const rows = await db.query.workspaces.findMany({
    where: (w, { inArray: inArrayOp }) => inArrayOp(w.id, [...new Set(ids)]),
    columns: { id: true, teamId: true },
  });
  return new Map(rows.map(r => [r.id, r.teamId ?? null]));
}

/**
 * The delegations a task token carries on this request. Narrowed here,
 * whatever the rows say, to workspaces of the task's own team (also the
 * minting account's team) that the minting key's workspace list allows: a
 * grant never reaches across teams or past the key that minted the token. Any
 * error reads as no delegation (fail closed).
 */
export async function loadTokenDelegations(
  taskId: string,
  workspaceId: string,
  account: { teamId?: string | null; workspaceIds?: string[] | null },
): Promise<ScheduleDelegationGrant[]> {
  try {
    const task = await db.query.tasks.findFirst({
      where: (t, { eq: eqOp }) => eqOp(t.id, taskId),
      columns: { id: true, workspaceId: true, scheduleId: true, delegation: true },
    });
    if (!task || task.workspaceId !== workspaceId) return [];
    const grants = await loadRawTaskGrants(task);
    if (!grants.length) return [];
    const teams = await teamsOf([workspaceId, ...grants.map(g => g.workspaceId)]);
    const ownTeam = teams.get(workspaceId);
    if (!ownTeam || (account.teamId && ownTeam !== account.teamId)) return [];
    return grants.filter(g => teams.get(g.workspaceId) === ownTeam && tokenWorkspaceAllowed(account.workspaceIds, g.workspaceId));
  } catch (err) {
    console.warn('[task-delegation] delegation lookup failed; none applied:', (err as Error)?.message ?? err);
    return [];
  }
}
