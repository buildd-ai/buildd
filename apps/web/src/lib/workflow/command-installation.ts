/**
 * The GitHub App installation a kernel command acts through, as the control
 * plane reads it (command-api.ts). It is derived from the repo the command
 * names, the same way the doors derive it (ci-red-sweep-deps.ts,
 * pr-supersession.ts):
 *
 *  - the workspace's own repo: the workspace's installation;
 *  - any other repo: the installation that covers that repo, falling back to
 *    the workspace's, and only for a repo inside the workspace's or one of its
 *    missions' repo scope (scope is read only for these, so a command on the
 *    workspace's own repo costs one parallel read).
 */
import { and, eq, isNotNull, or, sql, type AnyColumn, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';

export type InstallationResolution =
  | { installationId: number }
  | { refused: 'repo_out_of_scope' | 'no_installation' };

export interface InstallationLookups {
  /** The workspace's own repo and installation (linked repo first, as `pickWorkspaceRepoIdentity`). */
  workspace: (workspaceId: string) => Promise<{ fullName: string | null; installationId: number | null }>;
  /** The installation that covers this repo (`installationIdForRepo`). */
  forRepo: (repoFullName: string) => Promise<number | null>;
  /** Whether a repo other than the workspace's own is in the workspace's or its missions' repo scope. */
  inScope: (workspaceId: string, repoFullName: string) => Promise<boolean>;
}

const same = (a: string | null | undefined, b: string) => !!a && a.toLowerCase() === b.toLowerCase();

export async function expectedInstallation(
  workspaceId: string,
  repoFullName: string,
  lookups: InstallationLookups = defaultLookups,
): Promise<InstallationResolution> {
  const [ws, forRepo] = await Promise.all([lookups.workspace(workspaceId), lookups.forRepo(repoFullName)]);
  const own = same(ws.fullName, repoFullName);
  if (!own && !(await lookups.inScope(workspaceId, repoFullName))) return { refused: 'repo_out_of_scope' };
  const installationId = own ? (ws.installationId ?? forRepo) : (forRepo ?? ws.installationId);
  return installationId ? { installationId } : { refused: 'no_installation' };
}

// ── Defaults (Postgres) ─────────────────────────────────────────────────────

async function workspaceIdentity(workspaceId: string) {
  const { db } = await import('@buildd/core/db');
  const { workspaces } = await import('@buildd/core/db/schema');
  const { sqlWhere } = await import('@buildd/core/db/relational-sql');
  const { WORKSPACE_INSTALLATION_WITH, pickWorkspaceRepoIdentity } = await import('@/lib/workspace-installation');
  const ws = await db.query.workspaces.findFirst({
    where: sqlWhere(eq(workspaces.id, workspaceId)),
    columns: { id: true, repo: true },
    with: WORKSPACE_INSTALLATION_WITH,
  });
  const identity = pickWorkspaceRepoIdentity(ws);
  return { fullName: identity.fullName, installationId: identity.installationId };
}

async function forRepo(repoFullName: string) {
  return (await import('@/lib/workspace-installation')).installationIdForRepo(repoFullName);
}

/**
 * In scope: a worker of this workspace has a PR in the repo, or a mission with a task in this
 * workspace has a task whose workspace is the repo's, or whose worker has a PR in it.
 */
export async function repoInScope(workspaceId: string, repoFullName: string): Promise<boolean> {
  const { db } = await import('@buildd/core/db');
  const { githubRepos, tasks, workers, workspaces } = await import('@buildd/core/db/schema');
  const { normalizedRepoSql } = await import('@/lib/repo-scope');
  const repo = repoFullName.toLowerCase();
  const prIn = (col: AnyColumn): SQL => sql`starts_with(lower(${col}), ${`https://github.com/${repo}/pull/`})`;

  const own = db.select({ one: sql<number>`1` }).from(workers)
    .where(and(eq(workers.workspaceId, workspaceId), prIn(workers.prUrl)))
    .limit(1);

  const here = alias(tasks, 'scope_here');
  const sibling = alias(tasks, 'scope_sibling');
  const siblingWorker = alias(workers, 'scope_sibling_worker');
  const mission = db.select({ one: sql<number>`1` }).from(here)
    .innerJoin(sibling, eq(sibling.missionId, here.missionId))
    .innerJoin(workspaces, eq(workspaces.id, sibling.workspaceId))
    .leftJoin(githubRepos, eq(githubRepos.id, workspaces.githubRepoId))
    .leftJoin(siblingWorker, eq(siblingWorker.taskId, sibling.id))
    .where(and(
      eq(here.workspaceId, workspaceId),
      isNotNull(here.missionId),
      or(
        sql`${normalizedRepoSql(githubRepos.fullName)} = ${repo}`,
        sql`${normalizedRepoSql(workspaces.repo)} = ${repo}`,
        prIn(siblingWorker.prUrl),
      ),
    ))
    .limit(1);

  const [a, b] = await Promise.all([own, mission]);
  return a.length > 0 || b.length > 0;
}

const defaultLookups: InstallationLookups = { workspace: workspaceIdentity, forRepo, inScope: repoInScope };
