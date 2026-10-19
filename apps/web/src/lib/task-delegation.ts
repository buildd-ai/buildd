/**
 * Task delegation: the db half (rules: packages/core/token-delegation.ts).
 * The person and claim checks and the writes are in task-delegation-checks.ts:
 * this module is imported by token auth, so it stays free of drizzle helpers
 * (callback `where` only) and loads team access lazily.
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
import { mergeDelegationGrants, readScheduleDelegation, type ScheduleDelegationCapability, type ScheduleDelegationGrant } from '@buildd/core/token-delegation';
import { sqlWhereFn } from '@buildd/core/db/relational-sql';

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
      where: { RAW: sqlWhereFn((s, { eq: eqOp }) => eqOp(s.id, task.scheduleId!)) },
      columns: { workspaceId: true, delegation: true },
    });
    if (schedule && schedule.workspaceId === task.workspaceId) {
      grants = mergeDelegationGrants(readScheduleDelegation(schedule.delegation), grants).grants;
    }
  }
  return grants;
}

/**
 * The reach rule for a delegated capability (docs/specs/workspace-routing-and-reach.md
 * D-3): beyond team and grant, the account that mints the token must itself
 * reach the target, with `canCreate` for tasks:create. The claim pre-flight
 * and the token ask this same question, so a task the pre-flight passes is
 * one whose token reads and files where it was granted, and a runner that
 * cannot reach a restricted workspace never gets a token into it, whoever
 * granted the read.
 *
 * team-access is loaded here, on the first grant actually checked, not at
 * import: token auth imports this module, and the many route tests that stub
 * team-access with only the functions they use must still load it.
 */
export async function accountReachesDelegatedTarget(
  account: string | { id: string },
  workspaceId: string,
  capability: ScheduleDelegationCapability,
): Promise<boolean> {
  const { verifyAccountWorkspaceAccess } = await import('./team-access');
  return verifyAccountWorkspaceAccess(account as Parameters<typeof verifyAccountWorkspaceAccess>[0], workspaceId, capability === 'tasks:create' ? 'canCreate' : undefined);
}

export async function teamsOf(ids: string[]): Promise<Map<string, string | null>> {
  if (!ids.length) return new Map();
  const rows = await db.query.workspaces.findMany({
    where: { RAW: sqlWhereFn((w, { inArray: inArrayOp }) => inArrayOp(w.id, [...new Set(ids)])) },
    columns: { id: true, teamId: true },
  });
  return new Map(rows.map(r => [r.id, r.teamId ?? null]));
}

/**
 * The delegations a task token carries on this request. Narrowed here,
 * whatever the rows say, to workspaces of the task's own team (also the
 * minting account's team) that the minting key's workspace list allows and
 * the minting account itself reaches (accountReachesDelegatedTarget): a grant
 * never reaches across teams or past the account that minted the token. Any
 * error reads as no delegation (fail closed).
 */
export async function loadTokenDelegations(
  taskId: string,
  workspaceId: string,
  account: { id: string; teamId?: string | null; workspaceIds?: string[] | null },
): Promise<ScheduleDelegationGrant[]> {
  try {
    return await loadTokenDelegationsOrThrow(taskId, workspaceId, account);
  } catch (err) {
    console.warn('[task-delegation] delegation lookup failed; none applied:', (err as Error)?.message ?? err);
    return [];
  }
}

/**
 * loadTokenDelegations, throwing on a lookup error instead of answering none,
 * for a caller that must not mistake an error for "no delegation" (the token
 * auth cache, which would otherwise keep that answer).
 */
export async function loadTokenDelegationsOrThrow(
  taskId: string,
  workspaceId: string,
  account: { id: string; teamId?: string | null; workspaceIds?: string[] | null },
): Promise<ScheduleDelegationGrant[]> {
  const task = await db.query.tasks.findFirst({
    where: { RAW: sqlWhereFn((t, { eq: eqOp }) => eqOp(t.id, taskId)) },
    columns: { id: true, workspaceId: true, scheduleId: true, delegation: true },
  });
  if (!task || task.workspaceId !== workspaceId) return [];
  const grants = await loadRawTaskGrants(task);
  if (!grants.length) return [];
  const teams = await teamsOf([workspaceId, ...grants.map(g => g.workspaceId)]);
  const ownTeam = teams.get(workspaceId);
  if (!ownTeam || (account.teamId && ownTeam !== account.teamId)) return [];
  const out: ScheduleDelegationGrant[] = [];
  for (const g of grants) {
    if (teams.get(g.workspaceId) !== ownTeam || !tokenWorkspaceAllowed(account.workspaceIds, g.workspaceId)) continue;
    const capabilities: ScheduleDelegationCapability[] = [];
    for (const c of g.capabilities) {
      if (await accountReachesDelegatedTarget(account.id, g.workspaceId, c)) capabilities.push(c);
    }
    if (capabilities.length) out.push({ workspaceId: g.workspaceId, capabilities });
  }
  return out;
}
