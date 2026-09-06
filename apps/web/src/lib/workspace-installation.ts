/**
 * Workspace → GitHub App installation resolution.
 *
 * A workspace carries two pointers at an installation:
 *
 *   - `githubRepoId` → `github_repos.installationId` — refreshed on EVERY
 *     installation sync (`syncInstallationRepos`), so it survives an App
 *     uninstall/reinstall.
 *   - `githubInstallationId` — a legacy direct FK. Historically it was only
 *     written when the workspace was first linked, so after a reinstall it
 *     points at a dead installation row. The dead installation still mints a
 *     valid token, but that token has access to no repos: every call 404s.
 *
 * That divergence froze all PR lifecycle state in the buildd workspace from
 * 2026-08-22 onward — `pr-state-refresh` 404'd on every PR, `workers.mergedAt`
 * was never stamped, and both claim gates that read it (the deps gate's
 * "completed dep with an open PR still blocks", and the path-overlap backstop)
 * treated long-merged PRs as open. Claims returned `all_candidates_deferred`
 * with no pending task ever eligible.
 *
 * So: always prefer the repo-mediated installation, and keep the legacy FK only
 * as a fallback for workspaces that have no `githubRepoId` yet.
 */

import { sql } from 'drizzle-orm';

/** Drizzle `with` clause that loads both installation paths in one query. */
export const WORKSPACE_INSTALLATION_WITH = {
  githubRepo: { with: { installation: { columns: { installationId: true } } } },
  githubInstallation: { columns: { installationId: true } },
} as const;

export interface WorkspaceInstallationRow {
  githubRepo?: { installation?: { installationId: number | null } | null } | null;
  githubInstallation?: { installationId: number | null } | null;
}

/**
 * Returns the installation id to use for a workspace, preferring the
 * repo-mediated pointer over the legacy direct FK. Null when neither resolves.
 */
export function pickWorkspaceInstallationId(
  ws: WorkspaceInstallationRow | null | undefined,
): number | null {
  return ws?.githubRepo?.installation?.installationId
    ?? ws?.githubInstallation?.installationId
    ?? null;
}

/**
 * Installation that covers a specific repo, resolved through `github_repos`.
 *
 * A workspace's installation pointer only answers for the workspace's OWN
 * repo. Workers routinely open PRs in a different repo (a sibling mobile repo,
 * an umbrella repo), and coordination workspaces have no repo at all — so
 * anything that resolves a token from the workspace alone either queries the
 * wrong repo or gives up on rows that are perfectly reconcilable.
 *
 * Matches on the normalized full name so a `github_repos` row survives the
 * same URL-vs-slug inconsistency that `workspaces.repo` has.
 */
export async function installationIdForRepo(
  repoFullName: string,
): Promise<number | null> {
  const { db } = await import('@buildd/core/db');
  const { githubRepos } = await import('@buildd/core/db/schema');
  const { normalizedRepoSql } = await import('@/lib/repo-scope');

  const row = await db.query.githubRepos.findFirst({
    where: sql`${normalizedRepoSql(githubRepos.fullName)} = ${repoFullName.toLowerCase()}`,
    columns: { id: true },
    with: { installation: { columns: { installationId: true, suspendedAt: true } } },
  });

  // A suspended installation mints a token whose every call fails. Treat it as
  // no installation so the row records a failure and eventually retires,
  // rather than burning a GitHub call per run forever.
  if (row?.installation?.suspendedAt) return null;
  return row?.installation?.installationId ?? null;
}
