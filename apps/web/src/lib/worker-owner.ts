import { taskScopeAllowsWorker } from './task-token-auth';
import { isGrantSession } from './grant-scope';

/** The fields of an authenticated caller that say which person it is for. */
export interface ClaimingCaller {
  sessionUserId?: string | null;
  /** Set on an account-level grant session (lib/api-auth.ts). */
  oauthGrantId?: string | null;
  oauthUserId?: string | null;
  actsAs?: 'person' | 'agent' | null;
}

/**
 * The user whose claims this caller makes and owns, or null for a credential
 * that owns by account (a bld_ key, a per-task token).
 *
 * - An OAuth session acting as a person: that person (sessionUserId).
 * - An account-level 'agent' grant: the user who connected it (oauthUserId).
 *   It is never a person (lib/request-person.ts still refuses it), but every
 *   grant session in a team shares the team's session account, so the
 *   connecting user is the only thing that tells one member's agent from
 *   another's. Its claims belong to that user.
 */
export function claimingUserId(caller: ClaimingCaller | object): string | null {
  // Any account shape: the fields are optional, and absent means "owns by account".
  const account = caller as ClaimingCaller;
  if (typeof account.sessionUserId === 'string' && account.sessionUserId) return account.sessionUserId;
  if (account.actsAs === 'agent' && isGrantSession(account) && typeof account.oauthUserId === 'string' && account.oauthUserId) {
    return account.oauthUserId;
  }
  return null;
}

/**
 * The connecting user of an account-level 'agent' grant session, else null.
 * Such a session is an agent run on the shared team account; a worker on that
 * account is its own only when that user claimed it.
 */
export function agentConnectionUserId(caller: ClaimingCaller | object): string | null {
  const account = caller as ClaimingCaller;
  if (typeof account.sessionUserId === 'string' && account.sessionUserId) return null;
  return claimingUserId(account);
}

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
 * - An account-level 'agent' grant owns as the user who connected it
 *   (claimingUserId): one member's agent never owns another member's worker,
 *   nor a worker a key claimed on the shared account.
 *
 * Exact match only. There is no team-membership or admin fallback, and a
 * session with a missing team id or a worker with a missing workspace id is
 * never an owner. A worker a session claimed is not owned by a bld_ key on the
 * shared account, and a worker a key claimed is not owned by any session.
 */
export function callerOwnsWorker(
  account: ClaimingCaller & {
    id: string;
    teamId?: string | null;
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

  const sessionUser = claimingUserId(account);
  const claimer = worker.claimedByUserId ?? null;
  if (sessionUser === null && claimer === null) return true; // bld_ key on a key-claimed worker
  if (sessionUser === null || claimer === null) return false; // key vs session, either way round
  if (!account.teamId || !worker.workspaceId) return false;
  return sessionUser === claimer;
}
