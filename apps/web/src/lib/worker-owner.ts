import { taskScopeAllowsWorker } from './task-token-auth';

/**
 * Whether the caller is the principal that claimed this worker, and so may act
 * as it (report progress, read its instructions, complete it).
 *
 * - A bld_ key owns by account: the worker's accountId must be the caller's.
 *   A per-task token is further confined to its own task.
 * - An OAuth session acts as an account its whole team shares
 *   (lib/api-auth.ts), so the account says nothing about which member claimed.
 *   The claim records the session user on the worker (workers.claimedByUserId)
 *   and only that same user's session, on that same account, owns it.
 *
 * Exact match only. There is no team-membership or admin fallback, and a
 * session with a missing team id or a worker with a missing workspace id is
 * never an owner. A worker a session claimed is not owned by a bld_ key on the
 * shared account, and a worker a key claimed is not owned by any session.
 */
export function callerOwnsWorker(
  account: {
    id: string;
    teamId?: string | null;
    sessionUserId?: string | null;
    taskScope?: Parameters<typeof taskScopeAllowsWorker>[0]['taskScope'];
  },
  worker: {
    accountId: string | null;
    taskId: string | null;
    workspaceId?: string | null;
    claimedByUserId?: string | null;
  },
): boolean {
  if (!account.id || !worker.accountId || worker.accountId !== account.id) return false;
  if (!taskScopeAllowsWorker(account, worker)) return false;

  const sessionUser = account.sessionUserId ?? null;
  const claimer = worker.claimedByUserId ?? null;
  if (sessionUser === null && claimer === null) return true; // bld_ key on a key-claimed worker
  if (sessionUser === null || claimer === null) return false; // key vs session, either way round
  if (!account.teamId || !worker.workspaceId) return false;
  return sessionUser === claimer;
}
