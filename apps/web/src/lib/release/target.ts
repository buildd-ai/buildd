// Resolve a release target (workspace + linked repo + installation) from either
// a workspaceId or an "owner/name" repo string. Both release routes share this
// so the workspace's declared releaseConfig — not a buildd-specific default —
// drives the strategy.

import { db } from '@buildd/core/db';
import { workspaces, githubRepos } from '@buildd/core/db/schema';
import type { WorkspaceReleaseConfig, WorkspaceGitConfig } from '@buildd/core/db/schema';
import { and, eq, inArray } from 'drizzle-orm';
import { resolveWorkspace, type WorkspaceScope } from '@/lib/workspace-resolver';

export interface ReleaseTarget {
  workspaceId: string;
  workspaceName: string;
  owner: string;
  name: string;
  repoFullName: string;
  // Numeric GitHub installation id (what githubApi expects), not the row uuid.
  installationId: number;
  releaseConfig: WorkspaceReleaseConfig | null;
  defaultBranch: string;
  gitConfig: WorkspaceGitConfig | null;
}

export type ResolveTargetResult =
  | { ok: true; target: ReleaseTarget }
  | { ok: false; status: number; error: string };

/**
 * `scope` bounds where the target may be found. Request handlers pass the
 * teams the caller administers, so a workspaceId or repo outside them resolves
 * to "not found". `{ internal: true }` is for server-side callers that already
 * hold a trusted workspaceId (e.g. release-baseline), never for request input.
 */
export type ReleaseTargetScope = WorkspaceScope | { internal: true };

export async function resolveReleaseTarget(params: {
  workspaceId?: string;
  repo?: string;
  scope: ReleaseTargetScope;
}): Promise<ResolveTargetResult> {
  let workspaceRow: typeof workspaces.$inferSelect | undefined;
  let repoRow:
    | (typeof githubRepos.$inferSelect & { installation: { installationId: number } | null })
    | undefined;
  const { scope } = params;
  const isInternal = 'internal' in scope;

  if (params.workspaceId) {
    workspaceRow = isInternal
      ? await db.query.workspaces.findFirst({ where: eq(workspaces.id, params.workspaceId) })
      : (await resolveWorkspace(params.workspaceId, scope as WorkspaceScope)) ?? undefined;
    if (!workspaceRow) return { ok: false, status: 404, error: `Workspace ${params.workspaceId} not found` };
    if (!workspaceRow.githubRepoId) {
      return { ok: false, status: 400, error: 'Workspace has no linked GitHub repo' };
    }
    repoRow = await db.query.githubRepos.findFirst({
      where: eq(githubRepos.id, workspaceRow.githubRepoId),
      with: { installation: true },
    });
  } else if (params.repo) {
    const teamIds = isInternal ? null : (scope as WorkspaceScope).teamIds;
    if (teamIds && teamIds.length === 0) {
      return { ok: false, status: 404, error: `No linked repo found for ${params.repo}` };
    }
    // Several githubRepos rows can share a fullName (one per installation), so
    // match the workspace against all of them — but only in the scope's teams.
    const candidates = await db.query.githubRepos.findMany({
      where: eq(githubRepos.fullName, params.repo),
      with: { installation: true },
    });
    if (candidates.length === 0) return { ok: false, status: 404, error: `No linked repo found for ${params.repo}` };
    const found = await db.query.workspaces.findFirst({
      where: and(
        inArray(workspaces.githubRepoId, candidates.map(r => r.id)),
        teamIds ? inArray(workspaces.teamId, teamIds) : undefined,
      ),
    });
    if (!found) return { ok: false, status: 404, error: `No workspace linked to repo ${params.repo}` };
    workspaceRow = found;
    repoRow = candidates.find(r => r.id === found.githubRepoId);
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
      workspaceName: workspaceRow.name,
      owner: repoRow.owner,
      name: repoRow.name,
      repoFullName: repoRow.fullName,
      installationId: repoRow.installation.installationId,
      releaseConfig: workspaceRow.releaseConfig ?? null,
      defaultBranch: repoRow.defaultBranch ?? 'main',
      gitConfig: workspaceRow.gitConfig ?? null,
    },
  };
}
