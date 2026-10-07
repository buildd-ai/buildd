/**
 * May this caller act on this worker's PR, and as whom?
 *
 * The answer today is canActOnWorkerPr (team membership, or the account
 * running the worker with a live claim grant) plus the per-task token's own
 * confinement: a `bldt_` token acts only for its own task's worker, owned by
 * its minting account. This function applies exactly those two checks, in
 * that order, and additionally says WHO is acting:
 *
 *   - `agent_run`: the caller is the account that claimed the worker (a
 *     per-task token, or the runner/session key that claimed it). This is the
 *     run acting for itself.
 *   - `team_member`: someone else on the workspace's team (a person's MCP
 *     session, an organizer, another runner on the team).
 *
 * The classification changes nothing yet. It is what later rules key on
 * ("an agent run may close or merge only its own PR"), so those rules apply
 * to agent runs and leave people alone.
 *
 * Known imprecision: an OAuth MCP session resolves to the team's shared user
 * account, so a person on a team whose shared account claimed the worker is
 * classified `agent_run`. Rules that tighten on `agent_run` must also look at
 * the session user before refusing.
 *
 * Liveness is NOT checked here: a PR can be recorded for a worker that has
 * already finished, as it can today.
 */
import { db } from '@buildd/core/db';
import { workers } from '@buildd/core/db/schema';
import { and, eq } from 'drizzle-orm';
import { canActOnWorkerPr } from '@/lib/worker-pr-access';
import { taskScopeAllowsWorker, type TaskScope } from '@/lib/task-token-auth';
import type { getAccountWorkspacePermissions } from '@/lib/account-workspace-cache';
import { isOrchestrationTask } from '@buildd/shared';
import { taskNamesPr, type PrOwnershipTask } from './pr-ownership';
import type { AgentPrincipal } from './principal';
import type { GithubCapability } from './github';

export type WorkerPrCapability = Extract<GithubCapability, 'pr.create' | 'pr.adopt'>;

export interface WorkerPrCaller {
  id: string;
  teamId: string | null;
  taskScope?: TaskScope;
}

export interface WorkerPrSubject {
  id: string;
  accountId: string | null;
  taskId: string | null;
  workspaceId: string | null;
  workspace?: { id?: string; teamId: string | null } | null;
}

export type WorkerPrActor =
  | { kind: 'agent_run'; principal: AgentPrincipal }
  | { kind: 'team_member'; accountId: string };

export type WorkerPrDecision =
  | {
      allowed: true;
      capability: WorkerPrCapability;
      actor: WorkerPrActor;
      resource: { type: 'worker_pr'; workerId: string };
    }
  | {
      allowed: false;
      status: 403;
      error: string;
      reasonCode: 'not_team_or_runner' | 'outside_task_scope';
    };

// One text for both refusals, as the route has always answered.
const REFUSED = 'Worker belongs to different account';

function actorFor(caller: WorkerPrCaller, worker: WorkerPrSubject): WorkerPrActor {
  const workspaceId = worker.workspaceId ?? worker.workspace?.id ?? null;
  if (worker.accountId === caller.id && worker.taskId && workspaceId) {
    return {
      kind: 'agent_run',
      principal: {
        kind: 'agent_run',
        via: caller.taskScope ? 'task_token' : 'worker_account',
        workerId: worker.id,
        taskId: worker.taskId,
        workspaceId,
        teamId: worker.workspace?.teamId ?? null,
        accountId: caller.id,
      },
    };
  }
  return { kind: 'team_member', accountId: caller.id };
}

export async function authorizeWorkerPrCapability(
  caller: WorkerPrCaller,
  worker: WorkerPrSubject,
  capability: WorkerPrCapability,
  getGrants?: typeof getAccountWorkspacePermissions,
): Promise<WorkerPrDecision> {
  if (!(await canActOnWorkerPr(caller, worker, getGrants))) {
    return { allowed: false, status: 403, error: REFUSED, reasonCode: 'not_team_or_runner' };
  }
  // A per-task token may act only for its own task's worker, minted by the
  // worker's own account. Team membership does not widen it.
  if (caller.taskScope && (worker.accountId !== caller.id || !taskScopeAllowsWorker(caller, worker))) {
    return { allowed: false, status: 403, error: REFUSED, reasonCode: 'outside_task_scope' };
  }
  return {
    allowed: true,
    capability,
    actor: actorFor(caller, worker),
    resource: { type: 'worker_pr', workerId: worker.id },
  };
}

/** The mission of the task whose worker carries `prNumber` in this workspace, or null. */
export async function missionOfPr(workspaceId: string, prNumber: number): Promise<string | null> {
  const owner = await db.query.workers.findFirst({
    where: and(eq(workers.workspaceId, workspaceId), eq(workers.prNumber, prNumber)),
    // The callback form hands `desc` in, so this module needs no extra drizzle import.
    orderBy: (w, { desc }) => [desc(w.createdAt)],
    columns: { id: true },
    with: { task: { columns: { missionId: true } } },
  });
  return (owner as { task?: { missionId?: string | null } | null } | undefined)?.task?.missionId ?? null;
}

/**
 * May this caller close or merge `prNumber` through this worker?
 *
 * An agent run acting for itself may act on a PR its task owns: its own
 * worker's PR, or a PR the task names ("land PR #42", a retry's subject).
 * Applies to a per-task token and to a run still on its runner's key alike.
 * An orchestration task (organizer, planning, heartbeat) may also act on a
 * PR of another task on its own mission: tidying its mission's PRs is its
 * job, other missions' PRs are not. Exempt, unchanged: people (a session
 * user on the shared account) and teammates on other accounts.
 *
 * What this cannot see: a shared runner key naming a worker it also claimed.
 * merge_pr without workerId resolves the PR's own worker, which a shared key
 * cannot be told apart from. Per-task tokens close that; this does not try.
 */
export async function agentRunMayActOnPr(
  caller: { id: string; taskScope?: TaskScope } & object,
  worker: {
    accountId: string | null;
    workspaceId?: string | null;
    taskId?: string | null;
    prNumber?: number | null;
    task?: (PrOwnershipTask & { roleSlug?: string | null; mode?: string | null; missionId?: string | null }) | null;
  },
  prNumber: number,
  deps: { missionOfPr?: typeof missionOfPr } = {},
): Promise<boolean> {
  if ((caller as { sessionUserId?: string | null }).sessionUserId) return true;
  if (worker.accountId !== caller.id) return !caller.taskScope;
  if (caller.taskScope && worker.taskId !== caller.taskScope.taskId) return false;
  if (worker.prNumber === prNumber || taskNamesPr(worker.task, prNumber)) return true;
  if (!isOrchestrationTask(worker.task) || !worker.task?.missionId || !worker.workspaceId) return false;
  const mission = await (deps.missionOfPr ?? missionOfPr)(worker.workspaceId, prNumber);
  return mission === worker.task.missionId;
}
