// Resolve a release target (workspace + linked repo + installation) from either
// a workspaceId or an "owner/name" repo string. Both release routes share this
// so the workspace's declared releaseConfig — not a buildd-specific default —
// drives the strategy.

import { db } from '@buildd/core/db';
import { workspaces, githubRepos } from '@buildd/core/db/schema';
import type { WorkspaceReleaseConfig } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';

export interface ReleaseTarget {
  workspaceId: string;
  owner: string;
  name: string;
  repoFullName: string;
  // Numeric GitHub installation id (what githubApi expects), not the row uuid.
  installationId: number;
  releaseConfig: WorkspaceReleaseConfig | null;
  defaultBranch: string;
}

export type ResolveTargetResult =
  | { ok: true; target: ReleaseTarget }
  | { ok: false; status: number; error: string };

export async function resolveReleaseTarget(params: {
  workspaceId?: string;
  repo?: string;
}): Promise<ResolveTargetResult> {
  let workspaceRow: typeof workspaces.$inferSelect | undefined;
  let repoRow:
    | (typeof githubRepos.$inferSelect & { installation: { installationId: number } | null })
    | undefined;

  if (params.workspaceId) {
    workspaceRow = await db.query.workspaces.findFirst({ where: eq(workspaces.id, params.workspaceId) });
    if (!workspaceRow) return { ok: false, status: 404, error: `Workspace ${params.workspaceId} not found` };
    if (!workspaceRow.githubRepoId) {
      return { ok: false, status: 400, error: 'Workspace has no linked GitHub repo' };
    }
    repoRow = await db.query.githubRepos.findFirst({
      where: eq(githubRepos.id, workspaceRow.githubRepoId),
      with: { installation: true },
    });
  } else if (params.repo) {
    repoRow = await db.query.githubRepos.findFirst({
      where: eq(githubRepos.fullName, params.repo),
      with: { installation: true },
    });
    if (!repoRow) return { ok: false, status: 404, error: `No linked repo found for ${params.repo}` };
    workspaceRow = await db.query.workspaces.findFirst({ where: eq(workspaces.githubRepoId, repoRow.id) });
    if (!workspaceRow) return { ok: false, status: 404, error: `No workspace linked to repo ${params.repo}` };
  } else {
    return { ok: false, status: 400, error: 'workspaceId or repo is required' };
  }

  if (!repoRow?.installation) {
    return { ok: false, status: 404, error: 'No GitHub App installation for the workspace repo' };
  }

  return {
    ok: true,
    target: {
      workspaceId: workspaceRow.id,
      owner: repoRow.owner,
      name: repoRow.name,
      repoFullName: repoRow.fullName,
      installationId: repoRow.installation.installationId,
      releaseConfig: workspaceRow.releaseConfig ?? null,
      defaultBranch: repoRow.defaultBranch ?? 'main',
    },
  };
}
