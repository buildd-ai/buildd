/**
 * The repo-access check every PR door (create_pr, get_pr, merge_pr,
 * update_pr) runs before it calls GitHub.
 *
 * Fast path: the workspace is linked to a synced repo whose installation is
 * live and holds the permissions the operation needs — one query, as before.
 * Anything else goes through the full diagnosis, which may heal a
 * synced-but-unlinked repo and proceed, or refuses with a typed body naming
 * the unmet requirement and the person who can fix it.
 *
 * This used to be `!workspace.githubRepoId || !workspace.githubInstallationId
 * → "Workspace not linked to GitHub repo"`. The second half read the legacy
 * direct FK (see lib/workspace-installation.ts), so a workspace whose
 * repo-mediated installation was perfectly able to open the PR was refused
 * whenever that legacy column was empty.
 */
import { NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { githubRepos } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { GATE_SLUGS } from '@buildd/core/gate-events';
import { fireGateEvent } from '@/lib/gate-ledger';
import { appBaseUrl } from '@/lib/app-url';
import {
  describeRepoAccessProblem,
  missingPermissions,
  repoAccessErrorBody,
  type RepoAccessOperation,
  type RepoAccessProblem,
} from '@/lib/github-repo-access';
import {
  getGitHubAppIdentity,
  recordRepoAccessBlock,
  resolveWorkspaceRepoAccess,
} from '@/lib/github-repo-access-store';

type RepoWithInstallation = NonNullable<Awaited<ReturnType<typeof loadRepo>>> & {
  installation: NonNullable<NonNullable<Awaited<ReturnType<typeof loadRepo>>>['installation']>;
};

async function loadRepo(id: string) {
  return db.query.githubRepos.findFirst({
    where: eq(githubRepos.id, id),
    with: { installation: true },
  });
}

export type RepoAccessGateResult =
  | { ok: true; repo: RepoWithInstallation }
  | { ok: false; response: NextResponse };

export async function ensureRepoAccessForPr(params: {
  workspace: { id?: string | null; githubRepoId?: string | null } | null | undefined;
  workspaceId: string | null | undefined;
  operation: RepoAccessOperation;
  worker: { id?: string | null; taskId?: string | null };
  head?: string | null;
  surface: string;
}): Promise<RepoAccessGateResult> {
  const { workspace, operation } = params;
  const workspaceId = params.workspaceId ?? workspace?.id ?? null;

  if (workspace?.githubRepoId) {
    const repo = await loadRepo(workspace.githubRepoId);
    const inst = repo?.installation;
    if (repo && inst && !inst.suspendedAt && missingPermissions(inst.permissions as Record<string, string> | null, operation).length === 0) {
      return { ok: true, repo: repo as RepoWithInstallation };
    }
  }

  const { diagnosis } = await resolveWorkspaceRepoAccess(workspaceId, operation, { heal: true });
  if (diagnosis.ok) {
    const repo = await loadRepo(diagnosis.repo.id);
    if (repo?.installation) return { ok: true, repo: repo as RepoWithInstallation };
  }
  const problem: RepoAccessProblem = diagnosis.ok
    ? { reason: 'workspace_not_linked', operation, repoFullName: diagnosis.repo.fullName, installation: diagnosis.repo.installation, missingPermissions: [], repoRow: null }
    : diagnosis.problem;
  return { ok: false, response: await refuseForRepoAccess({ ...params, workspaceId, problem }) };
}

/**
 * The typed refusal. Also used when GitHub itself answers 403 "Resource not
 * accessible by integration" mid-operation — the installation's recorded
 * permissions were stale.
 */
export async function refuseForRepoAccess(params: {
  workspaceId: string | null | undefined;
  problem: RepoAccessProblem;
  worker: { id?: string | null; taskId?: string | null };
  head?: string | null;
  surface: string;
}): Promise<NextResponse> {
  const { problem, worker } = params;
  const app = await getGitHubAppIdentity();
  const remediation = describeRepoAccessProblem(problem, { app, viewer: null });

  // Only a refused write leaves the task waiting: a get_pr that cannot read
  // has nothing to resume.
  let alreadyReported = false;
  if (params.workspaceId && problem.operation !== 'pr.read') {
    ({ alreadyReported } = await recordRepoAccessBlock({
      taskId: worker.taskId,
      workerId: worker.id,
      workspaceId: params.workspaceId,
      problem,
      head: params.head ?? null,
    }));
  }

  const frictionSignature = fireGateEvent({
    gate: GATE_SLUGS.GITHUB_REPO_ACCESS,
    surface: params.surface,
    outcome: 'rejected',
    reason: problem.reason,
    workspaceId: params.workspaceId ?? null,
    taskId: worker.taskId ?? null,
    workerId: worker.id ?? null,
    callerOrigin: 'worker',
    detail: { operation: problem.operation, alreadyReported },
  });

  return NextResponse.json(
    repoAccessErrorBody({
      problem,
      remediation,
      workspaceId: params.workspaceId ?? '',
      appBaseUrl: appBaseUrl(),
      alreadyReported,
      frictionSignature,
    }),
    // 409: the request is fine, the workspace's GitHub connection is not in
    // a state that allows it yet. Not 400 (nothing to fix in the call) and not
    // 500 (nothing broke).
    { status: 409 },
  );
}
