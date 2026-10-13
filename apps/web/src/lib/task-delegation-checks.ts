/**
 * Task delegation checks and writes: the claim pre-flight, a person's write,
 * and the grant an approved tasks:create request adds (rules:
 * packages/core/token-delegation.ts; loader: task-delegation.ts).
 */
import { db } from '@buildd/core/db';
import { tasks } from '@buildd/core/db/schema';
import { and, eq } from 'drizzle-orm';
import { tokenWorkspaceAllowed } from '@buildd/core/token-scopes';
import {
  findDelegationGaps,
  mergeDelegationGrants,
  parseScheduleDelegationInput,
  readFilingTargets,
  readScheduleDelegation,
  removeDelegationCapability,
  type DelegationGap,
  type ScheduleDelegationCapability,
  type TaskDelegation,
} from '@buildd/core/token-delegation';
import { loadRawTaskGrants, teamsOf } from './task-delegation';
import { verifyAccountWorkspaceAccess, verifyWorkspaceAccess } from './team-access';
import { sqlWhere } from '@buildd/core/db/relational-sql';

type DelegatedTaskRow = Parameters<typeof loadRawTaskGrants>[0];

/**
 * Claim pre-flight: what this task needs across workspaces (its delegation and
 * its declared filing targets) that the token minted from `account` would not
 * carry or could not use. Empty = start the run. Uses the same reach rules as
 * the routes a delegated call lands on: same team, the minting key's workspace
 * list, and the account's own access (`canCreate` for tasks:create).
 */
export async function preflightTaskDelegation(
  task: DelegatedTaskRow & { context?: unknown },
  account: Parameters<typeof verifyAccountWorkspaceAccess>[0] & { id: string; teamId?: string | null; workspaceIds?: string[] | null },
): Promise<DelegationGap[]> {
  const filingTargets = readFilingTargets(task.context).filter(t => t !== task.workspaceId);
  const grants = await loadRawTaskGrants(task);
  if (!grants.length && !filingTargets.length) return [];
  const teams = await teamsOf([task.workspaceId, ...grants.map(g => g.workspaceId)]);
  const reach = new Map<string, boolean>();
  for (const g of grants) {
    for (const capability of g.capabilities) {
      const key = `${g.workspaceId}|${capability}`;
      const ok = tokenWorkspaceAllowed(account.workspaceIds, g.workspaceId)
        && await verifyAccountWorkspaceAccess(account, g.workspaceId, capability === 'tasks:create' ? 'canCreate' : undefined);
      reach.set(key, ok);
    }
  }
  return findDelegationGaps({
    grants,
    filingTargets,
    ownTeamId: teams.get(task.workspaceId) ?? null,
    teamOf: ws => teams.get(ws),
    accountReaches: (ws, cap) => reach.get(`${ws}|${cap}`) === true,
  });
}

export type DelegationWrite =
  | { ok: true; value: TaskDelegation | null }
  | { ok: false; status: number; error: string };

/**
 * Validate and stamp a person's `delegation` write on a task. Only a person
 * (a dashboard session, or the person's own OAuth session) may grant reach:
 * an API key or task token never can, whatever its level. Every target must
 * be a workspace of the task's own team that the person reaches themselves.
 * `null` (or no grants) clears it.
 */
export async function resolveTaskDelegationWrite(
  input: unknown,
  taskWorkspaceId: string,
  personUserId: string | null,
): Promise<DelegationWrite> {
  if (!personUserId) {
    return {
      ok: false,
      status: 403,
      error: 'Only a person can grant a task delegation (a dashboard or OAuth session that reaches each target). An agent declares the need with filingTargets; a person grants it with update_task before the task is claimed, or approves its tasks:create capability request.',
    };
  }
  const parsed = parseScheduleDelegationInput(input, taskWorkspaceId, 'task');
  if (!parsed.ok) return { ok: false, status: 400, error: parsed.error };
  if (parsed.grants === null) return { ok: true, value: null };
  const teams = await teamsOf([taskWorkspaceId, ...parsed.grants.map(g => g.workspaceId)]);
  const ownTeam = teams.get(taskWorkspaceId);
  if (!ownTeam) return { ok: false, status: 404, error: 'Workspace not found' };
  for (const g of parsed.grants) {
    if (teams.get(g.workspaceId) !== ownTeam) {
      return { ok: false, status: 400, error: `workspace ${g.workspaceId} is not a workspace of this task's team` };
    }
    if (!(await verifyWorkspaceAccess(personUserId, g.workspaceId))) {
      return { ok: false, status: 403, error: `you cannot grant access to workspace ${g.workspaceId}: you do not reach it yourself` };
    }
  }
  return {
    ok: true,
    value: { grants: parsed.grants, grantedByUserId: personUserId, grantedByAccountId: null, grantedAt: new Date().toISOString() },
  };
}

/**
 * Add one approved grant to a task's delegation (a person approved its
 * `tasks:create` capability request). Read-modify-write guarded on the value
 * read, retried once: no interactive transactions on neon-http.
 */
export async function addTaskDelegationGrant(
  taskId: string,
  grant: { workspaceId: string; capability: ScheduleDelegationCapability },
  by: { userId: string; capabilityGrantId: string },
): Promise<{ ok: true } | { ok: false; error: string }> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const task = await db.query.tasks.findFirst({ where: sqlWhere(eq(tasks.id, taskId)), columns: { id: true, delegation: true, updatedAt: true } });
    if (!task) return { ok: false, error: 'Task not found' };
    const current = task.delegation as TaskDelegation | null;
    const merged = mergeDelegationGrants(readScheduleDelegation(current), [{ workspaceId: grant.workspaceId, capabilities: [grant.capability] }]);
    if (merged.overflow.length) return { ok: false, error: 'The task already delegates the maximum number of workspaces.' };
    const next: TaskDelegation = {
      grants: merged.grants,
      grantedByUserId: by.userId,
      grantedByAccountId: null,
      grantedAt: new Date().toISOString(),
      ...(current?.inheritedFromTaskId ? { inheritedFromTaskId: current.inheritedFromTaskId } : {}),
      capabilityGrantIds: [...new Set([...(current?.capabilityGrantIds ?? []), by.capabilityGrantId])],
    };
    const [row] = await db.update(tasks)
      .set({ delegation: next, updatedAt: new Date() })
      .where(and(eq(tasks.id, taskId), eq(tasks.updatedAt, task.updatedAt)))
      .returning({ id: tasks.id });
    if (row) return { ok: true };
  }
  return { ok: false, error: 'The task changed while the grant was being written; approve again.' };
}

/** Take one capability on one workspace back off a task's delegation (a revoked request). */
export async function removeTaskDelegationGrant(
  taskId: string,
  grant: { workspaceId: string; capability: ScheduleDelegationCapability },
): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const task = await db.query.tasks.findFirst({ where: sqlWhere(eq(tasks.id, taskId)), columns: { id: true, delegation: true, updatedAt: true } });
    if (!task?.delegation) return;
    const current = task.delegation as TaskDelegation;
    const grants = removeDelegationCapability(readScheduleDelegation(current), grant.workspaceId, grant.capability);
    const next: TaskDelegation | null = grants.length ? { ...current, grants } : null;
    const [row] = await db.update(tasks)
      .set({ delegation: next, updatedAt: new Date() })
      .where(and(eq(tasks.id, taskId), eq(tasks.updatedAt, task.updatedAt)))
      .returning({ id: tasks.id });
    if (row) return;
  }
}
