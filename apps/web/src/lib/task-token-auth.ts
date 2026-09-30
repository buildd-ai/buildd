import { db } from '@buildd/core/db';
import { accounts } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { authenticateApiKey } from './api-auth';
import { isTaskToken, taskTokenKeyBinding, verifyTaskToken } from './task-token';

/**
 * Authentication for the few routes a cloud container's per-task token may
 * use (see lib/task-token.ts for the list and the invariant).
 *
 * Any other key goes through authenticateApiKey unchanged. A task token
 * resolves to its minting account at `worker` level, never flagged as a host
 * runner, carrying `taskScope`. A route that calls this MUST then confine the
 * request to its own task: `taskScopeAllowsTask` / `taskScopeAllowsWorker` /
 * `taskScopeAllowsWorkspace` (enforced by task-token-routes.test.ts).
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

export async function authenticateTaskScopedCaller(apiKey: string | null): Promise<TaskScopedAccount | null> {
  if (!isTaskToken(apiKey)) return authenticateApiKey(apiKey);
  const claims = verifyTaskToken(apiKey);
  if (!claims) return null;
  const account = await db.query.accounts.findFirst({ where: eq(accounts.id, claims.accountId) });
  if (!account) return null;
  if (taskTokenKeyBinding(account.apiKey) !== claims.keyBinding) return null;
  return {
    ...account,
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
