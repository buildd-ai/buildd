/**
 * Create a workspace in a team the caller is already allowed to create in.
 * `POST /api/workspaces` resolves the team and checks `create_workspace`, then
 * calls this; so does the connect-repo page (lib/connect-repo.ts). The GitHub
 * installation check lives here so no caller can link an installation into a
 * team it does not belong to.
 */
import { eq } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { githubRepos, workspaces, type WorkspaceGitConfig } from '@buildd/core/db/schema';
import { clearCallerCache, callerDep } from '@/lib/caller-cache';
import { getInstallationOwnerTeamIds } from '@/lib/github-installation-access';
import { enqueueFullIngestJob, logIngestSkip } from '@/lib/knowledge-ingest';
import { normalizeRepoFullName } from '@/lib/repo-scope';
import { emit } from '@/lib/core-emit';
import { invalidateAppChrome } from '@/lib/app-chrome';

export interface GithubRepoInput {
  id?: string | number;
  repoId?: string | number;
  fullName: string;
  name: string;
  owner: string;
  private?: boolean;
  defaultBranch?: string;
  htmlUrl?: string | null;
  description?: string | null;
}

export interface CreateWorkspaceInput {
  teamId: string;
  name: string;
  repoUrl?: string | null;
  defaultBranch?: string | null;
  gitConfig?: unknown;
  githubRepo?: GithubRepoInput | null;
  githubInstallationId?: string | null;
  accessMode?: string | null;
  knowledgeIngest: boolean;
  origin: string;
  /** The person acting, if any: their app shell is refreshed. */
  userId?: string | null;
}

export type CreateWorkspaceResult =
  | { ok: true; workspace: typeof workspaces.$inferSelect }
  | { ok: false; status: 403 | 409; error: string };

export async function createWorkspace(input: CreateWorkspaceInput): Promise<CreateWorkspaceResult> {
  const { teamId, repoUrl, githubRepo, githubInstallationId } = input;

  // A GitHub installation may only be linked into a team it belongs to (see
  // lib/github-installation-access.ts).
  if (githubInstallationId) {
    const ownerTeamIds = await getInstallationOwnerTeamIds(githubInstallationId);
    if (!ownerTeamIds.includes(teamId)) {
      return { ok: false, status: 403, error: 'That GitHub installation is not connected to this team' };
    }
  }

  // If a GitHub repo is selected, persist it on-demand
  let githubRepoDbId: string | null = null;
  if (githubRepo && githubInstallationId) {
    const [upserted] = await db
      .insert(githubRepos)
      .values({
        installationId: githubInstallationId,
        repoId: parseInt(String(githubRepo.repoId || githubRepo.id)),
        fullName: githubRepo.fullName,
        name: githubRepo.name,
        owner: githubRepo.owner,
        private: githubRepo.private ?? false,
        defaultBranch: githubRepo.defaultBranch || 'main',
        htmlUrl: githubRepo.htmlUrl || null,
        description: githubRepo.description || null,
      })
      .onConflictDoUpdate({
        target: githubRepos.repoId,
        // Only refresh a row that already belongs to this installation.
        setWhere: eq(githubRepos.installationId, githubInstallationId),
        set: {
          fullName: githubRepo.fullName,
          name: githubRepo.name,
          owner: githubRepo.owner,
          private: githubRepo.private ?? false,
          defaultBranch: githubRepo.defaultBranch || 'main',
          htmlUrl: githubRepo.htmlUrl || null,
          description: githubRepo.description || null,
          updatedAt: new Date(),
        },
      })
      .returning();
    if (!upserted) {
      return { ok: false, status: 409, error: 'That repository is linked through a different GitHub installation' };
    }
    githubRepoDbId = upserted.id;
  }

  // Merge gitConfig: support both top-level defaultBranch (legacy) and gitConfig.defaultBranch (new)
  const mergedGitConfig: Record<string, unknown> = {
    ...(input.gitConfig && typeof input.gitConfig === 'object' ? input.gitConfig : {}),
  };
  if (input.defaultBranch) {
    mergedGitConfig.defaultBranch = input.defaultBranch;
  }

  const [workspace] = await db
    .insert(workspaces)
    .values({
      name: input.name,
      // Canonical `owner/name` when parseable, else the caller's input
      // verbatim — see the PATCH handler for why unparseable input survives.
      repo: repoUrl ? (normalizeRepoFullName(repoUrl) ?? repoUrl) : null,
      localPath: input.defaultBranch || null,
      githubRepoId: githubRepoDbId,
      githubInstallationId: githubInstallationId || null,
      accessMode: (input.accessMode || 'open') as typeof workspaces.$inferInsert.accessMode,
      knowledgeIngest: input.knowledgeIngest,
      gitConfig: Object.keys(mergedGitConfig).length > 0 ? (mergedGitConfig as unknown as WorkspaceGitConfig) : null,
      teamId,
    })
    .returning();

  // Created open: the team's accounts reach it on their next call; so does
  // an MCP connection covering the team as a whole.
  await clearCallerCache(callerDep.teamOpenWorkspaces(teamId), callerDep.teamWorkspaces(teamId));

  // Modules react (e.g. connectors preinstalled from the team's catalog).
  await emit({ type: 'workspace.created', workspaceId: workspace.id, teamId, origin: input.origin });

  // Auto-ingest on repo link: enqueue a full ingest job when a repo URL was
  // provided, unless the workspace was created with knowledge ingest off.
  if (repoUrl && !input.knowledgeIngest) {
    logIngestSkip('workspace_create', { workspaceId: workspace.id });
  } else if (repoUrl) {
    const fullName = normalizeRepoFullName(repoUrl);
    if (fullName) {
      enqueueFullIngestJob({ workspaceId: workspace.id, repo: fullName, trigger: 'repo_link' }).catch(err =>
        console.error(`[knowledge-ingest] repo-link enqueue failed for new workspace ${workspace.id}:`, err)
      );
    }
  }

  // The acting user's shell shows this at once (lib/app-chrome.ts).
  if (input.userId) invalidateAppChrome(input.userId);
  return { ok: true, workspace };
}
