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
 *
 * Either way the command acts only through its own team's installation: one resolved
 * from the repo is used only when it belongs to the workspace's team
 * (`installationBelongsToTeam`, lib/github-installation-access.ts), else the command
 * is refused. The workspace's own linked installation is the team's by that same rule.
 */
import { and, eq, isNotNull, or, sql, type AnyColumn, type SQL } from 'drizzle-orm';

export type InstallationResolution =
  | { installationId: number }
  | { refused: 'repo_out_of_scope' | 'no_installation' | 'installation_not_team_owned' };

export interface InstallationLookups {
  /** The workspace's own repo and installation (linked repo first, as `pickWorkspaceRepoIdentity`). */
  workspace: (workspaceId: string) => Promise<{ teamId: string | null; fullName: string | null; installationId: number | null }>;
  /** The installation that covers this repo (`installationIdForRepo`). */
  forRepo: (repoFullName: string) => Promise<number | null>;
  /** Whether a repo other than the workspace's own is in the workspace's or its missions' repo scope. */
  inScope: (workspaceId: string, repoFullName: string) => Promise<boolean>;
  /** Whether an installation belongs to this team (`installationBelongsToTeam`). */
  ownedByTeam: (installationId: number, teamId: string) => Promise<boolean>;
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
  if (!installationId) return { refused: 'no_installation' };
  // The workspace's own link needs no second read; one found through the repo must be the team's.
  if (installationId !== ws.installationId && !(ws.teamId && await lookups.ownedByTeam(installationId, ws.teamId))) {
    return { refused: 'installation_not_team_owned' };
  }
  return { installationId };
}

// ── Defaults (Postgres) ─────────────────────────────────────────────────────

async function workspaceIdentity(workspaceId: string) {
  const { db } = await import('@buildd/core/db');
  const { workspaces } = await import('@buildd/core/db/schema');
  const { sqlWhere } = await import('@buildd/core/db/relational-sql');
  const { WORKSPACE_INSTALLATION_WITH, pickWorkspaceRepoIdentity } = await import('@/lib/workspace-installation');
  const ws = await db.query.workspaces.findFirst({
    where: sqlWhere(eq(workspaces.id, workspaceId)),
    columns: { id: true, teamId: true, repo: true },
    with: WORKSPACE_INSTALLATION_WITH,
  });
  const identity = pickWorkspaceRepoIdentity(ws);
  return { teamId: ws?.teamId ?? null, fullName: identity.fullName, installationId: identity.installationId };
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

  // The workspace's missions and their tasks, each read once through an index as an array
  // (`= any(array(...))`, an InitPlan), so a check costs the missions' own size, never a pass over a
  // whole table or one row per pair of mission tasks, and stops at its first hit.
  const anyOf = (col: AnyColumn, sub: SQL | object): SQL => sql`${col} = any(array(${sub}))`;
  const missionIds = db.selectDistinct({ id: tasks.missionId }).from(tasks)
    .where(and(eq(tasks.workspaceId, workspaceId), isNotNull(tasks.missionId)));

  // A workspace of one of those missions is bound to the repo.
  const missionWorkspace = db.select({ one: sql<number>`1` }).from(workspaces)
    .leftJoin(githubRepos, eq(githubRepos.id, workspaces.githubRepoId))
    .where(and(
      anyOf(workspaces.id, db.selectDistinct({ id: tasks.workspaceId }).from(tasks).where(anyOf(tasks.missionId, missionIds))),
      or(sql`${normalizedRepoSql(githubRepos.fullName)} = ${repo}`, sql`${normalizedRepoSql(workspaces.repo)} = ${repo}`),
    ))
    .limit(1);

  // A worker on one of those missions' tasks has a PR in the repo.
  const missionPr = db.select({ one: sql<number>`1` }).from(tasks)
    .innerJoin(workers, eq(workers.taskId, tasks.id))
    .where(and(anyOf(tasks.missionId, missionIds), prIn(workers.prUrl)))
    .limit(1);

  const hits = await Promise.all([own, missionWorkspace, missionPr]);
  return hits.some((rows) => rows.length > 0);
}

async function ownedByTeam(installationId: number, teamId: string) {
  return (await import('@/lib/github-installation-access')).installationBelongsToTeam(installationId, teamId);
}

const defaultLookups: InstallationLookups = { workspace: workspaceIdentity, forRepo, inScope: repoInScope, ownedByTeam };
