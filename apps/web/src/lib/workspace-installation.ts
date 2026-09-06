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
import { normalizeRepoFullName } from '@/lib/repo-scope';

/**
 * Drizzle `with` clause that loads both installation paths plus the linked
 * repo's canonical identity, in one query.
 *
 * The `githubRepo` columns are what let `pickWorkspaceRepoIdentity` prefer the
 * FK over `workspaces.repo`. Drop them and the picker silently degrades to the
 * text fallback for every workspace.
 */
export const WORKSPACE_INSTALLATION_WITH = {
  githubRepo: {
    columns: { fullName: true, defaultBranch: true, repoId: true },
    with: { installation: { columns: { installationId: true } } },
  },
  githubInstallation: { columns: { installationId: true } },
} as const;

export interface WorkspaceInstallationRow {
  githubRepo?: { installation?: { installationId: number | null } | null } | null;
  githubInstallation?: { installationId: number | null } | null;
}

/** A workspace row carrying enough to resolve which repo it is about. */
export interface WorkspaceRepoRow extends WorkspaceInstallationRow {
  repo?: string | null;
  githubRepo?: {
    fullName?: string | null;
    defaultBranch?: string | null;
    repoId?: number | null;
    installation?: { installationId: number | null } | null;
  } | null;
}

export interface WorkspaceRepoIdentity {
  /** Canonical `owner/name`, safe to interpolate into a GitHub API path. */
  fullName: string | null;
  installationId: number | null;
  defaultBranch: string | null;
  /** GitHub's immutable numeric repo id. Only set via the linked row. */
  repoId: number | null;
  /**
   * Which source answered. Logged by the reconcile sweep on a failed GitHub
   * call: a 404 on an FK-derived repo and a 404 on a stale free-text one are
   * different bugs, and this is the only place that distinction survives.
   */
  source: 'github_repo' | 'workspace_text' | 'none';
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

/**
 * The repo a workspace is about, preferring the linked `github_repos` row over
 * the free-text `workspaces.repo` column.
 *
 * Why the FK wins, and why this does NOT simply normalize the column:
 * `github_repos` is keyed on GitHub's immutable numeric `repoId` and refreshed
 * on every installation sync, so it follows a repo rename. Free text never
 * does. A normalized-but-stale slug is worse than a malformed one — it is
 * well-formed enough to pass every check a caller might write, and still 404s.
 *
 * Measured against production: every workspace with a repo also has a
 * `githubRepoId`, and the normalized text agrees with the linked row in every
 * case, so the column currently carries no information the FK lacks. It
 * survives as a fallback for the one case the FK cannot express — a repo the
 * user declared that is not linked yet (App not installed, or a host the App
 * cannot reach).
 *
 * `fullName` is always either a valid `owner/name` or null; never a raw URL.
 */
export function pickWorkspaceRepoIdentity(
  ws: WorkspaceRepoRow | null | undefined,
): WorkspaceRepoIdentity {
  const installationId = pickWorkspaceInstallationId(ws);

  // The linked row is authoritative, but still validated: a `full_name` that
  // is not `owner/name` is no more usable for an API path than a URL is.
  const linked = normalizeRepoFullName(ws?.githubRepo?.fullName);
  if (linked) {
    return {
      fullName: linked,
      installationId,
      defaultBranch: ws?.githubRepo?.defaultBranch ?? null,
      repoId: ws?.githubRepo?.repoId ?? null,
      source: 'github_repo',
    };
  }

  const declared = normalizeRepoFullName(ws?.repo);
  if (declared) {
    return {
      fullName: declared,
      installationId,
      defaultBranch: null,
      repoId: null,
      source: 'workspace_text',
    };
  }

  return { fullName: null, installationId, defaultBranch: null, repoId: null, source: 'none' };
}
