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
