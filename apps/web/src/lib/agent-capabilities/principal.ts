/**
 * The agent-run principal: who is acting when a running agent asks buildd for
 * access. Not the person who created the task, and not the runner's account
 * as a whole, but ONE live worker on ONE task in ONE workspace.
 *
 * Resolving a principal re-checks everything the claim checked, because
 * access revoked mid-run must stop the next request:
 *   - claim authority: an open workspace of the account's own team, or an
 *     explicit canClaim grant; a workspace-restricted key only inside its list
 *   - liveness: the worker is in a live status, on this task and workspace,
 *     claimed by this account
 *
 * Loaders live in dispatch-principal.ts (cloud: task + dispatch token) and
 * worker-principal.ts (self-hosted: worker id). Capabilities a principal may
 * hold are decided in github.ts. Nothing here mints or returns a credential.
 *
 * Design: knowledge-base buildd/design/agent-capability-broker.md
 */
import { createHash, timingSafeEqual } from 'crypto';
import { tokenWorkspaceAllowed } from '@buildd/core/token-scopes';
import { getAccountWorkspacePermissions } from '@/lib/account-workspace-cache';
import { LIVE_WORKER_STATUSES } from '@/lib/task-presentation';
import { isOpenWithinTeams } from '@/lib/open-workspaces';

export interface AgentPrincipal {
  kind: 'agent_run';
  /**
   * How the run proved itself: the cloud dispatch token, a runner key naming
   * its worker, a per-task token, or being the account that claimed the worker.
   */
  via: 'dispatch' | 'runner_key' | 'task_token' | 'worker_account';
  workerId: string;
  taskId: string;
  workspaceId: string;
  teamId: string | null;
  accountId: string;
}

/**
 * Why no principal resolved. `reasonCode` is stable for callers and tests;
 * `error` is the human text each route already returns. Every "not yours"
 * answer is a 404, so a refusal never confirms that another team's id exists.
 */
export interface PrincipalRefusal {
  ok: false;
  status: 403 | 404 | 409;
  error: string;
  reasonCode: 'not_found' | 'dispatch_token_mismatch' | 'no_live_worker' | 'worker_not_live';
}

export interface PrincipalAccount {
  id: string;
  teamId: string | null;
  workspaceIds?: readonly string[] | null;
}

export interface PrincipalWorkspace {
  id: string;
  teamId: string | null;
  accessMode: string | null;
}

const LIVE = new Set<string>(LIVE_WORKER_STATUSES);

export function isLiveWorkerStatus(status: string | null | undefined): boolean {
  return !!status && LIVE.has(status);
}

/** The claim route's authority rule, re-applied on every request. */
export async function hasClaimAuthority(
  account: PrincipalAccount,
  ws: PrincipalWorkspace,
  getGrants: typeof getAccountWorkspacePermissions = getAccountWorkspacePermissions,
): Promise<boolean> {
  if (!tokenWorkspaceAllowed(account.workspaceIds, ws.id)) return false;
  if (account.teamId && isOpenWithinTeams(ws, [account.teamId])) return true;
  const grants = await getGrants(account.id);
  return grants.some(g => g.workspaceId === ws.id && g.canClaim);
}

/** Constant-time over fixed-length digests, so neither length nor prefix leaks. */
function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

/**
 * The workspace's enabled webhook token matches the one presented. The cloud
 * container holds the runner key but never this token, so it is what stops
 * the container asking for its own grants.
 */
export function dispatchTokenMatches(
  hook: { enabled?: boolean; token?: unknown } | null | undefined,
  presented: string,
): boolean {
  return !!hook && !!hook.enabled && typeof hook.token === 'string' && hook.token.length > 0 && safeEqual(hook.token, presented);
}

export interface WorkerRow {
  id: string;
  taskId: string | null;
  workspaceId: string | null;
  accountId: string | null;
  status: string;
}

/**
 * The live workers on `taskId` that belong to this account and workspace
 * (and are `workerId`, when given). Re-checked here rather than trusted to
 * the query, so the rule is visible and tested.
 */
export function ownLiveWorkers(
  rows: readonly WorkerRow[],
  want: { taskId: string; workspaceId: string; accountId: string; workerId?: string },
): WorkerRow[] {
  return rows.filter(w =>
    w.taskId === want.taskId &&
    w.workspaceId === want.workspaceId &&
    w.accountId === want.accountId &&
    isLiveWorkerStatus(w.status) &&
    (want.workerId === undefined || w.id === want.workerId));
}
