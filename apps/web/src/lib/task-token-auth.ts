import { db } from '@buildd/core/db';
import { accounts } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { authenticateApiKey } from './api-auth';
import { isTaskToken, missingTaskTokenScopes, taskTokenKeyBinding, verifyTaskToken } from './task-token';
import { tokenWorkspaceAllowed } from '@buildd/core/token-scopes';

/**
 * Authentication for the few routes a cloud container's per-task token may
 * use (see lib/task-token.ts for the list and the invariant).
 *
 * Any other key goes through authenticateApiKey unchanged. A task token
 * resolves to its minting account at `worker` level, never flagged as a host
 * runner, carrying `taskScope`. A route that calls this MUST then confine the
 * request to its own task: `taskScopeAllowsTask` / `taskScopeAllowsWorker` /
 * `taskScopeAllowsWorkspace` / `taskScopeAllowsMission` /
 * `taskScopeAllowsInitiative` (enforced by task-token-routes.test.ts).
 *
 * A token stops authenticating when its minting key is regenerated or the
 * account is deleted: the token is bound to the key hash current at mint time.
 */

export interface TaskScope {
  taskId: string;
  /** The task's workspace: the only one the token may reach. */
  workspaceId: string;
  expiresAt: number;
}

type ApiAccount = NonNullable<Awaited<ReturnType<typeof authenticateApiKey>>>;
export type TaskScopedAccount = ApiAccount & { taskScope?: TaskScope };

export async function authenticateTaskScopedCaller(
  apiKey: string | null,
  request?: { url: string; method: string },
): Promise<TaskScopedAccount | null> {
  // Account keys keep every check authenticateApiKey applies, including a
  // scoped token's route capability and workspace checks when the route
  // passes its request (without one, a scoped token is refused).
  if (!isTaskToken(apiKey)) return request ? authenticateApiKey(apiKey, request) : authenticateApiKey(apiKey);
  const claims = verifyTaskToken(apiKey);
  if (!claims) return null;
  const account = await db.query.accounts.findFirst({ where: eq(accounts.id, claims.accountId) });
  if (!account) return null;
  if (taskTokenKeyBinding(account.apiKey) !== claims.keyBinding) return null;
  // The minting key's current scopes and workspace list still bound the
  // token: narrowing the key below the runner capabilities, or dropping the
  // task's workspace from its list, ends the tokens it minted.
  if (missingTaskTokenScopes(account.scopes).length > 0) return null;
  if (!tokenWorkspaceAllowed(account.workspaceIds, claims.workspaceId)) return null;
  if (account.expiresAt && new Date(account.expiresAt).getTime() <= Date.now()) return null;
  return {
    ...account,
    scopes: null,
    workspaceIds: null,
    level: 'worker',
    hostRunner: false,
    taskScope: { taskId: claims.taskId, workspaceId: claims.workspaceId, expiresAt: claims.expiresAt },
  };
}

/** True unless the caller is a task token for a different task. */
export function taskScopeAllowsTask(account: { taskScope?: TaskScope }, taskId: string | null | undefined): boolean {
  if (!account.taskScope) return true;
  return !!taskId && taskId === account.taskScope.taskId;
}

/**
 * True unless the caller is a task token and the worker is not on its task.
 * Callers still check `worker.accountId === account.id`; together that is
 * "its own worker".
 */
export function taskScopeAllowsWorker(account: { taskScope?: TaskScope }, worker: { taskId: string | null }): boolean {
  return taskScopeAllowsTask(account, worker.taskId);
}

/** True unless the caller is a task token and the workspace is not its task's. */
export function taskScopeAllowsWorkspace(account: { taskScope?: TaskScope }, workspaceId: string | null | undefined): boolean {
  if (!account.taskScope) return true;
  return !!workspaceId && workspaceId === account.taskScope.workspaceId;
}

/**
 * True unless the caller is a task token and `prNumber` is not the PR recorded
 * on its own task's worker. A task token may close, merge or request review
 * only for the PR its own run opened; reading PRs is confined to the
 * workspace instead (`taskScopeAllowsWorkspace`).
 */
export function taskScopeAllowsWorkerPr(
  account: { id: string; taskScope?: TaskScope },
  worker: { taskId: string | null; accountId?: string | null; prNumber?: number | null },
  prNumber: number,
): boolean {
  if (!account.taskScope) return true;
  if (!taskScopeAllowsTask(account, worker.taskId)) return false;
  if (worker.accountId !== undefined && worker.accountId !== account.id) return false;
  return worker.prNumber === prNumber;
}

/**
 * The mission of a task token's own task, and that mission's initiative.
 * One read; null when the task is gone or not in the token's workspace. The
 * `where` callback keeps this module off the schema's table exports.
 */
async function ownTaskMission(scope: TaskScope): Promise<{ missionId: string | null; initiativeId: string | null } | null> {
  const task = await db.query.tasks.findFirst({
    where: (t, { eq: eqOp }) => eqOp(t.id, scope.taskId),
    columns: { missionId: true, workspaceId: true },
    with: { mission: { columns: { initiativeId: true } } },
  });
  if (!task || task.workspaceId !== scope.workspaceId) return null;
  return { missionId: task.missionId ?? null, initiativeId: task.mission?.initiativeId ?? null };
}

/**
 * True unless the caller is a task token and `missionId` is not its own
 * task's mission. Mission writes (notes, mission-level artifacts) are
 * confined to that one mission.
 */
export async function taskScopeAllowsMission(
  account: { taskScope?: TaskScope },
  missionId: string | null | undefined,
): Promise<boolean> {
  if (!account.taskScope) return true;
  if (!missionId) return false;
  const own = await ownTaskMission(account.taskScope);
  return !!own?.missionId && own.missionId === missionId;
}

/**
 * True unless the caller is a task token and `initiativeId` is not the
 * initiative its own task's mission belongs to.
 */
export async function taskScopeAllowsInitiative(
  account: { taskScope?: TaskScope },
  initiativeId: string | null | undefined,
): Promise<boolean> {
  if (!account.taskScope) return true;
  if (!initiativeId) return false;
  const own = await ownTaskMission(account.taskScope);
  return !!own?.initiativeId && own.initiativeId === initiativeId;
}

/**
 * True unless the caller is a task token and `workerId` names a worker that is
 * not its own (same account, its own task). For a worker id a client passes
 * in a body to attribute a write, e.g. a note's author, which decides whose
 * next check-in receives the reply. An absent id is allowed.
 */
export async function taskScopeAllowsWorkerId(
  account: { id: string; taskScope?: TaskScope },
  workerId: string | null | undefined,
): Promise<boolean> {
  if (!account.taskScope || !workerId) return true;
  const worker = await db.query.workers.findFirst({
    where: (w, { eq: eqOp }) => eqOp(w.id, workerId),
    columns: { taskId: true, accountId: true },
  });
  return !!worker && worker.accountId === account.id && taskScopeAllowsWorker(account, worker);
}
