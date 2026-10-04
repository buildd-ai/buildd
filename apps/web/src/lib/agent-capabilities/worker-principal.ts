/**
 * Resolve the principal for a self-hosted run, from the runner key (already
 * authenticated by the route) and the worker id it names.
 *
 * Used by /api/runner/agent-github-token.
 */
import { db } from '@buildd/core/db';
import { workers } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import {
  type AgentPrincipal,
  type PrincipalAccount,
  type PrincipalRefusal,
  hasClaimAuthority,
  isLiveWorkerStatus,
} from './principal';

async function loadWorker(workerId: string) {
  return db.query.workers.findFirst({
    where: eq(workers.id, workerId),
    columns: { id: true, taskId: true, workspaceId: true, accountId: true, status: true },
    with: {
      workspace: {
        columns: { id: true, teamId: true, accessMode: true, githubRepoId: true },
        with: {
          githubRepo: {
            columns: { id: true, repoId: true, owner: true, name: true, fullName: true },
            with: {
              installation: { columns: { installationId: true, suspendedAt: true, permissions: true } },
            },
          },
        },
      },
    },
  });
}

type LoadedWorker = NonNullable<Awaited<ReturnType<typeof loadWorker>>>;
export type RunnerWorkspace = NonNullable<LoadedWorker['workspace']>;

export type WorkerPrincipalResult =
  | { ok: true; principal: AgentPrincipal; workspace: RunnerWorkspace }
  | PrincipalRefusal;

const NOT_FOUND: PrincipalRefusal = { ok: false, status: 404, error: 'Worker not found', reasonCode: 'not_found' };

export async function resolveWorkerPrincipal(
  account: PrincipalAccount,
  input: { workerId: string },
): Promise<WorkerPrincipalResult> {
  const worker = await loadWorker(input.workerId);
  const ws = worker?.workspace;
  // Same 404 for "no such worker" and "another account's worker".
  if (!worker || !ws || worker.workspaceId !== ws.id || worker.accountId !== account.id) return NOT_FOUND;

  if (!(await hasClaimAuthority(account, ws))) return NOT_FOUND;

  if (!worker.taskId || !isLiveWorkerStatus(worker.status)) {
    return { ok: false, status: 409, error: 'Worker is not live', reasonCode: 'worker_not_live' };
  }

  return {
    ok: true,
    principal: {
      kind: 'agent_run',
      via: 'runner_key',
      workerId: worker.id,
      taskId: worker.taskId,
      workspaceId: ws.id,
      teamId: ws.teamId,
      accountId: account.id,
    },
    workspace: ws,
  };
}
