import { db } from '@buildd/core/db';
import { githubInstallations, githubRepos } from '@buildd/core/db/schema';
import { eq, sql } from 'drizzle-orm';
import { listInstallationRepos } from '@/lib/github';

export interface SyncInstallationReposResult {
  synced: number;
  linked: number;
  linkedWorkspaceIds: string[];
}

const EMPTY_RESULT: SyncInstallationReposResult = { synced: 0, linked: 0, linkedWorkspaceIds: [] };

/**
 * Normalizes `workspaces.repo` down to a bare lowercase `owner/name` so a
 * workspace stored in any of these shapes matches the same GitHub repo:
 *   owner/name · https://github.com/owner/name · git@github.com:owner/name.git
 *
 * Substring matching (the old `ilike '%owner/name%'`) is deliberately avoided:
 * it also matches unrelated repos like `owner/name-legacy`.
 */
const NORMALIZED_WORKSPACE_REPO = sql`lower(
  regexp_replace(
    regexp_replace(
      coalesce(w.repo, ''),
      '^(https?://(www\\.)?github\\.com/|git@github\\.com:|ssh://git@github\\.com/)',
      ''
    ),
    '(\\.git)?/*$',
    ''
  )
)`;

/**
 * Upserts every repo on an installation into `github_repos`, then back-links any
 * workspace that points at one of those repos but has no `githubRepoId` yet.
 *
 * Two round trips regardless of repo count: one multi-row upsert, one
 * `UPDATE ... FROM` join. Both are idempotent, so this is safe to call on every
 * installation webhook as well as from the manual sync endpoint.
 *
 * Note: back-linking matches on repo full name alone, so it is installation-
 * scoped but not account-scoped — a workspace owned by a different buildd
 * account that points at the same repo would also be linked. Acceptable today
 * (repos are not shared across accounts); revisit if buildd goes multi-tenant.
 */
export async function syncInstallationRepos(installation: {
  id: string;
  installationId: number;
}): Promise<SyncInstallationReposResult> {
  const ghRepos = (await listInstallationRepos(installation.installationId)) as Array<
    Record<string, unknown>
  >;
  if (ghRepos.length === 0) return { ...EMPTY_RESULT };

  const rows = ghRepos.map((repo) => {
    const fullName = repo.full_name as string;
    return {
      installationId: installation.id,
      repoId: repo.id as number,
      fullName,
      name: (repo.name as string) || fullName.split('/')[1],
      owner: ((repo.owner as Record<string, unknown>)?.login as string) || fullName.split('/')[0],
      private: (repo.private as boolean) ?? false,
      defaultBranch: (repo.default_branch as string) || 'main',
      htmlUrl: (repo.html_url as string) || null,
      description: (repo.description as string) || null,
    };
  });

  await db
    .insert(githubRepos)
    .values(rows)
    .onConflictDoUpdate({
      target: githubRepos.repoId,
      set: {
        installationId: sql`excluded.installation_id`,
        fullName: sql`excluded.full_name`,
        name: sql`excluded.name`,
        owner: sql`excluded.owner`,
        private: sql`excluded.private`,
        defaultBranch: sql`excluded.default_branch`,
        htmlUrl: sql`excluded.html_url`,
        description: sql`excluded.description`,
        updatedAt: new Date(),
      },
    });

  const backLinked = await db.execute(sql`
    UPDATE workspaces w
    SET github_repo_id = r.id,
        github_installation_id = r.installation_id,
        updated_at = now()
    FROM github_repos r
    WHERE r.installation_id = ${installation.id}::uuid
      AND w.github_repo_id IS NULL
      AND ${NORMALIZED_WORKSPACE_REPO} = lower(r.full_name)
    RETURNING w.id
  `);

  const linkedWorkspaceIds = ((backLinked?.rows ?? []) as Array<{ id: string }>).map((r) => r.id);

  return { synced: rows.length, linked: linkedWorkspaceIds.length, linkedWorkspaceIds };
}

/**
 * `syncInstallationRepos` keyed by GitHub's numeric installation id — the only
 * identifier webhook payloads carry. No-ops if the installation row is missing
 * (e.g. an `installation_repositories` delivery that lands before/after the
 * `installation` row exists).
 */
export async function syncInstallationReposById(
  installationId: number
): Promise<SyncInstallationReposResult> {
  const installation = await db.query.githubInstallations.findFirst({
    where: eq(githubInstallations.installationId, installationId),
    columns: { id: true, installationId: true },
  });
  if (!installation) return { ...EMPTY_RESULT };
  return syncInstallationRepos(installation);
}
