/**
 * Resolve the principal for a cloud run, from what the cloud runner's
 * dispatcher presents: the runner key (already authenticated by the route),
 * the workspace's dispatch token, and `{ taskId, workerId? }`.
 *
 * Used by /api/runner/github-token and /api/runner/model-endpoint.
 */
import { db } from '@buildd/core/db';
import { tasks, workers } from '@buildd/core/db/schema';
import { and, eq, inArray } from 'drizzle-orm';
import { LIVE_WORKER_STATUSES } from '@/lib/task-presentation';
import {
  type AgentPrincipal,
  type PrincipalAccount,
  type PrincipalRefusal,
  dispatchTokenMatches,
  hasClaimAuthority,
  ownLiveWorkers,
} from './principal';

async function loadTask(taskId: string) {
  return db.query.tasks.findFirst({
    where: eq(tasks.id, taskId),
    columns: { id: true, workspaceId: true, backend: true },
    with: {
      workspace: {
        columns: { id: true, teamId: true, accessMode: true, webhookConfig: true, githubRepoId: true, gitConfig: true, releaseConfig: true },
        with: {
          githubRepo: {
            columns: { id: true, repoId: true, owner: true, name: true, fullName: true, defaultBranch: true },
            with: {
              installation: { columns: { installationId: true, suspendedAt: true, permissions: true } },
            },
          },
        },
      },
    },
  });
}

type LoadedTask = NonNullable<Awaited<ReturnType<typeof loadTask>>>;
export type DispatchTask = LoadedTask;
export type DispatchWorkspace = NonNullable<LoadedTask['workspace']>;

export type DispatchPrincipalResult =
  | { ok: true; principal: AgentPrincipal; task: LoadedTask; workspace: DispatchWorkspace }
  | PrincipalRefusal;

const NOT_FOUND: PrincipalRefusal = { ok: false, status: 404, error: 'Task not found', reasonCode: 'not_found' };

export async function resolveDispatchPrincipal(
  account: PrincipalAccount,
  input: { taskId: string; workerId?: string; dispatchToken: string },
): Promise<DispatchPrincipalResult> {
  const task = await loadTask(input.taskId);
  const ws = task?.workspace;
  if (!task || !ws || task.workspaceId !== ws.id) return NOT_FOUND;

  if (!(await hasClaimAuthority(account, ws))) return NOT_FOUND;

  if (!dispatchTokenMatches(ws.webhookConfig, input.dispatchToken)) {
    return { ok: false, status: 403, error: 'Dispatch token does not match this workspace', reasonCode: 'dispatch_token_mismatch' };
  }

  const rows = await db.query.workers.findMany({
    where: and(eq(workers.taskId, input.taskId), inArray(workers.status, [...LIVE_WORKER_STATUSES])),
    columns: { id: true, accountId: true, workspaceId: true, status: true, taskId: true },
  });
  const mine = ownLiveWorkers(rows, { taskId: input.taskId, workspaceId: ws.id, accountId: account.id, workerId: input.workerId });
  if (mine.length === 0) {
    return { ok: false, status: 409, error: 'Task has no live worker claimed by this account', reasonCode: 'no_live_worker' };
  }

  return {
    ok: true,
    principal: {
      kind: 'agent_run',
      via: 'dispatch',
      // Without a workerId the task's live worker stands in. One task has at
      // most one live worker in practice; any of them satisfies the rule above.
      workerId: mine[0]!.id,
      taskId: task.id,
      workspaceId: ws.id,
      teamId: ws.teamId,
      accountId: account.id,
    },
    task,
    workspace: ws,
  };
}
