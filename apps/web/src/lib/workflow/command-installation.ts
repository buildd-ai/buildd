/**
 * The GitHub App installation a kernel command acts through, as the control
 * plane reads it (command-api.ts). It is derived from the repo the command
 * names, the same way the doors derive it (ci-red-sweep-deps.ts,
 * pr-supersession.ts):
 *
 *  - the workspace's own repo: the workspace's installation;
 *  - any other repo: the installation that covers that repo, falling back to
 *    the workspace's, and only for a repo linked to a workspace of one of its
 *    missions (`repoInScope`: scope comes from the team's own repo links; it is
 *    read only for these, so a command on the workspace's own repo costs one
 *    parallel read).
 *
 * Either way the command acts only through its own team's installation: one resolved
 * from the repo is used only when it belongs to the workspace's team
 * (`installationBelongsToTeam`, lib/github-installation-access.ts), else the command
 * is refused. The workspace's own linked installation is the team's by that same rule.
 */
import { and, eq, isNotNull, sql, type AnyColumn, type SQL } from 'drizzle-orm';

export type InstallationResolution =
  | { installationId: number }
  | { refused: 'repo_out_of_scope' | 'no_installation' | 'installation_not_team_owned' };

export interface InstallationLookups {
  /**
   * The workspace's own repo and installation (linked repo first, as `pickWorkspaceRepoIdentity`).
   * `linked: false` when the repo comes only from the free-text `workspaces.repo` column.
   */
  workspace: (workspaceId: string) => Promise<{ teamId: string | null; fullName: string | null; installationId: number | null; linked?: boolean }>;
  /** The installation that covers this repo (`installationIdForRepo`). */
  forRepo: (repoFullName: string) => Promise<number | null>;
  /** Whether a repo other than the workspace's own is linked to a workspace of one of its missions. */
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
  // A repo named only in the free-text column is no link: it acts only through the installation
  // that covers it, and only when that one is the team's.
  const textOnly = own && ws.linked === false;
  const installationId = textOnly ? forRepo : own ? (ws.installationId ?? forRepo) : (forRepo ?? ws.installationId);
  if (!installationId) return { refused: 'no_installation' };
  // The workspace's own link needs no second read; one found through the repo must be the team's.
  if ((textOnly || installationId !== ws.installationId) && !(ws.teamId && await lookups.ownedByTeam(installationId, ws.teamId))) {
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
  return { teamId: ws?.teamId ?? null, fullName: identity.fullName, installationId: identity.installationId, linked: identity.source === 'github_repo' };
}

// Unscoped on purpose: `expectedInstallation` checks the answer with `ownedByTeam` itself and
// refuses with `installation_not_team_owned`, a reason the control plane reports by name.
async function forRepo(repoFullName: string) {
  return (await import('@/lib/workspace-installation')).installationIdForRepo(repoFullName);
}

/**
 * In scope: the repo is linked (`github_repos`, through `workspaces.github_repo_id`) to a workspace
 * of this workspace's team, of a mission with a task in this workspace. Scope comes from the team's own repo links only, never
 * from a PR URL recorded on a worker row or the free-text `workspaces.repo` column. A PR buildd opens
 * or adopts through the GitHub App is always in its own workspace's linked repo
 * (`ensureRepoAccessForPr`, `pr.adopt`, `task-pr-attach.ts`), so this covers those too.
 */
export async function repoInScope(workspaceId: string, repoFullName: string): Promise<boolean> {
  const { db } = await import('@buildd/core/db');
  const { githubRepos, tasks, workspaces } = await import('@buildd/core/db/schema');
  const { normalizedRepoSql } = await import('@/lib/repo-scope');
  const repo = repoFullName.toLowerCase();

  // The workspace's missions and their tasks' workspaces, each read once through an index as an
  // array (`= any(array(...))`, an InitPlan), so a check costs the missions' own size, never a pass
  // over a whole table, and stops at its first hit.
  const anyOf = (col: AnyColumn, sub: SQL | object): SQL => sql`${col} = any(array(${sub}))`;
  const missionIds = db.selectDistinct({ id: tasks.missionId }).from(tasks)
    .where(and(eq(tasks.workspaceId, workspaceId), isNotNull(tasks.missionId)));

  const rows = await db.select({ one: sql<number>`1` }).from(workspaces)
    .innerJoin(githubRepos, eq(githubRepos.id, workspaces.githubRepoId))
    .where(and(
      anyOf(workspaces.id, db.selectDistinct({ id: tasks.workspaceId }).from(tasks).where(anyOf(tasks.missionId, missionIds))),
      // Only the team's own workspaces, whatever a mission row holds.
      sql`${workspaces.teamId} = (SELECT w0.team_id FROM workspaces w0 WHERE w0.id = ${workspaceId}::uuid)`,
      sql`${normalizedRepoSql(githubRepos.fullName)} = ${repo}`,
    ))
    .limit(1);
  return rows.length > 0;
}

async function ownedByTeam(installationId: number, teamId: string) {
  return (await import('@/lib/github-installation-access')).installationBelongsToTeam(installationId, teamId);
}

const defaultLookups: InstallationLookups = { workspace: workspaceIdentity, forRepo, inScope: repoInScope, ownedByTeam };
