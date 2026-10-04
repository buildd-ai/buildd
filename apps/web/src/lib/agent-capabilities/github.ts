/**
 * GitHub capabilities an agent-run principal may hold, and the one grant that
 * materializes as a credential: a short-lived installation token scoped to the
 * workspace's linked repository.
 *
 * Authorization and minting are separate on purpose. `authorizeGithubRepoGrant`
 * is pure and decides; `mintGithubRepoGrant` talks to GitHub and only runs on
 * an allowed decision.
 *
 * Repo identity comes only from workspace.githubRepoId → github_repos, never
 * from the free-text workspaces.repo, a git remote, or anything the caller sends.
 *
 * The token cannot be narrowed below one repository: GitHub has no branch
 * scope for installation tokens. Branch policy is enforced elsewhere (cloud
 * egress, rulesets), so these capabilities name what buildd intends, not
 * what the token alone prevents.
 */
import { mintRepoScopedInstallationToken, type ScopedInstallationToken } from '@/lib/github-scoped-token';
import type { AgentPrincipal } from './principal';

export type GithubCapability =
  | 'git.read'
  | 'git.push_task_branch'
  | 'pr.create'
  | 'pr.adopt'
  | 'pr.comment'
  | 'pr.request_review'
  | 'pr.close'
  | 'pr.merge';

/** What the repo-scoped token stands for: the git data plane. PR actions go through buildd. */
export const REPO_GRANT_CAPABILITIES: readonly GithubCapability[] = ['git.read', 'git.push_task_branch'];

export interface LinkedGithubRepo {
  id: string;
  repoId: number;
  owner: string;
  name: string;
  fullName: string;
  installation: { installationId: number; suspendedAt: Date | string | null; permissions: Record<string, string> | null } | null;
}

export type GithubRepoGrantDecision =
  | {
      allowed: true;
      principal: AgentPrincipal;
      capabilities: readonly GithubCapability[];
      resource: { type: 'github_repo'; id: string };
      repo: { repoId: number; owner: string; name: string; fullName: string };
      installation: { installationId: number; permissions: Record<string, string> | null };
    }
  | {
      allowed: false;
      status: 409;
      error: string;
      reasonCode: 'no_linked_repo' | 'installation_suspended';
    };

export function authorizeGithubRepoGrant(
  principal: AgentPrincipal,
  ws: { githubRepoId: string | null; githubRepo: LinkedGithubRepo | null },
): GithubRepoGrantDecision {
  const repo = ws.githubRepo;
  if (!ws.githubRepoId || !repo || repo.id !== ws.githubRepoId || !repo.installation) {
    return { allowed: false, status: 409, error: 'Workspace has no linked GitHub repository', reasonCode: 'no_linked_repo' };
  }
  if (repo.installation.suspendedAt) {
    return { allowed: false, status: 409, error: 'GitHub App installation is suspended', reasonCode: 'installation_suspended' };
  }
  return {
    allowed: true,
    principal,
    capabilities: REPO_GRANT_CAPABILITIES,
    resource: { type: 'github_repo', id: repo.id },
    repo: { repoId: repo.repoId, owner: repo.owner, name: repo.name, fullName: repo.fullName },
    installation: { installationId: repo.installation.installationId, permissions: repo.installation.permissions },
  };
}

export async function mintGithubRepoGrant(
  decision: Extract<GithubRepoGrantDecision, { allowed: true }>,
): Promise<ScopedInstallationToken> {
  return mintRepoScopedInstallationToken({
    installationId: decision.installation.installationId,
    repoId: decision.repo.repoId,
    installedPermissions: decision.installation.permissions,
  });
}
