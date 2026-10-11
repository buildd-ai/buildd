/**
 * Loads the facts `diagnoseRepoAccess` judges, heals the one state that needs
 * no GitHub change (a synced repo the workspace was never linked to), stamps
 * tasks a refused PR operation left waiting, and resumes them once access is
 * verified.
 *
 * Authoritative state is the existing `github_installations` / `github_repos`
 * mirror, reached through the same team-ownership rule the installation sync
 * uses (lib/github-installation-access.ts). Nothing here keeps a second copy.
 */
import { db } from '@buildd/core/db';
import { githubInstallations, githubRepos, tasks, users, workspaces } from '@buildd/core/db/schema';
import { and, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import { isGitHubAppConfigured, generateAppJWT } from '@/lib/github';
import { getInstallationOwnerTeamIds } from '@/lib/github-installation-access';
import { syncInstallationRepos } from '@/lib/github-repo-link';
import { normalizeRepoFullName, normalizedRepoSql } from '@/lib/repo-scope';
import { wakeTasks } from '@/lib/dispatch-authority';
import {
  describeRepoAccessProblem,
  diagnoseRepoAccess,
  repoAccessSettingsPath,
  type RepoAccessRemediation,
  type GitHubAppIdentity,
  type GithubAccessBlock,
  type InstallationFacts,
  type RepoAccessDiagnosis,
  type RepoAccessFacts,
  type RepoAccessOperation,
  type RepoAccessProblem,
  type RepoRowFacts,
} from '@/lib/github-repo-access';

/** How long a refused task stays resumable, and how many one recovery wakes. */
export const BLOCK_WINDOW_DAYS = 7;
export const MAX_RESUME = 100;

// ── App identity ────────────────────────────────────────────────────────────

let appIdentityCache: { value: GitHubAppIdentity | null; at: number } | null = null;
const APP_IDENTITY_TTL_MS = 60 * 60 * 1000;

/**
 * The App as GitHub describes it (`GET /app`): its real slug, page and the
 * permissions it requests. Cached for an hour; null when the App is not
 * configured or GitHub cannot be reached, in which case callers show no
 * install link rather than a guessed one.
 */
export async function getGitHubAppIdentity(): Promise<GitHubAppIdentity | null> {
  if (appIdentityCache && Date.now() - appIdentityCache.at < APP_IDENTITY_TTL_MS) return appIdentityCache.value;
  if (!isGitHubAppConfigured()) return null;
  let value: GitHubAppIdentity | null = null;
  try {
    const res = await fetch('https://api.github.com/app', {
      headers: {
        Authorization: `Bearer ${generateAppJWT()}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (res.ok) {
      const app = await res.json() as { slug?: unknown; html_url?: unknown; permissions?: unknown };
      if (typeof app.slug === 'string' && typeof app.html_url === 'string') {
        value = {
          slug: app.slug,
          htmlUrl: app.html_url,
          permissions: (app.permissions && typeof app.permissions === 'object' ? app.permissions : {}) as Record<string, string>,
        };
      }
    }
  } catch (err) {
    console.warn('[github-repo-access] GET /app failed:', err instanceof Error ? err.message : err);
  }
  // A failure is cached too (briefly, via the same TTL) so a GitHub outage
  // does not add a round trip to every refused PR call.
  appIdentityCache = { value, at: Date.now() };
  return value;
}

/** Test seam. */
export function __resetAppIdentityCache() {
  appIdentityCache = null;
}

// ── Facts ───────────────────────────────────────────────────────────────────

const INSTALLATION_COLUMNS = {
  id: true,
  installationId: true,
  accountLogin: true,
  accountType: true,
  accountId: true,
  installedByUserId: true,
  repositorySelection: true,
  suspendedAt: true,
  permissions: true,
} as const;

type InstallationRow = {
  id: string;
  installationId: number;
  accountLogin: string;
  accountType: 'Organization' | 'User';
  accountId: number;
  installedByUserId: string | null;
  repositorySelection: 'all' | 'selected' | null;
  suspendedAt: Date | null;
  permissions: Record<string, string> | null;
};

function toInstallation(row: InstallationRow | null | undefined): InstallationFacts | null {
  if (!row) return null;
  return {
    id: row.id,
    installationId: row.installationId,
    accountLogin: row.accountLogin,
    accountType: row.accountType,
    accountId: row.accountId,
    installedByUserId: row.installedByUserId ?? null,
    repositorySelection: row.repositorySelection ?? null,
    suspendedAt: row.suspendedAt ?? null,
    permissions: row.permissions ?? null,
  };
}

async function teamOwns(installationDbId: string, teamId: string): Promise<boolean> {
  return (await getInstallationOwnerTeamIds(installationDbId)).includes(teamId);
}

export interface LoadedRepoAccess {
  workspace: { id: string; teamId: string; repo: string | null };
  facts: RepoAccessFacts;
}

export async function loadRepoAccessFacts(workspaceId: string): Promise<LoadedRepoAccess | null> {
  const ws = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, workspaceId),
    columns: { id: true, teamId: true, repo: true, githubRepoId: true },
    with: {
      githubRepo: {
        columns: { id: true, fullName: true, defaultBranch: true },
        with: { installation: { columns: INSTALLATION_COLUMNS } },
      },
    },
  });
  if (!ws) return null;

  const linked = ws.githubRepo as (RepoRowFacts & { installation: InstallationRow | null }) | null;
  const linkedRepo: RepoRowFacts | null = linked
    ? { id: linked.id, fullName: linked.fullName, defaultBranch: linked.defaultBranch ?? null, installation: toInstallation(linked.installation) }
    : null;
  const declaredRepo = normalizeRepoFullName(linked?.fullName) ?? normalizeRepoFullName(ws.repo);

  let unlinkedRepo: RepoRowFacts | null = null;
  let ownerInstallations: InstallationFacts[] = [];

  if (!linkedRepo?.installation && declaredRepo) {
    // A synced row for the declared repo, under an installation this team
    // owns. Another team's installation is never borrowed: that is what keeps
    // one team from reaching a private repo through someone else's grant.
    const candidates = await db.query.githubRepos.findMany({
      where: sql`${normalizedRepoSql(githubRepos.fullName)} = ${declaredRepo.toLowerCase()}`,
      columns: { id: true, fullName: true, defaultBranch: true },
      with: { installation: { columns: INSTALLATION_COLUMNS } },
      limit: 5,
    });
    for (const c of candidates) {
      if (c.installation && await teamOwns(c.installation.id, ws.teamId)) {
        unlinkedRepo = { id: c.id, fullName: c.fullName, defaultBranch: c.defaultBranch ?? null, installation: toInstallation(c.installation as InstallationRow) };
        break;
      }
    }

    if (!unlinkedRepo) {
      const owner = declaredRepo.split('/')[0].toLowerCase();
      const onOwner = await db.query.githubInstallations.findMany({
        where: sql`lower(${githubInstallations.accountLogin}) = ${owner}`,
        columns: INSTALLATION_COLUMNS,
      });
      for (const inst of onOwner) {
        if (await teamOwns(inst.id, ws.teamId)) ownerInstallations.push(toInstallation(inst as InstallationRow)!);
      }
    }
  }

  const app = isGitHubAppConfigured() ? await getGitHubAppIdentity() : null;

  return {
    workspace: { id: ws.id, teamId: ws.teamId, repo: ws.repo ?? null },
    facts: {
      appConfigured: isGitHubAppConfigured(),
      declaredRepo,
      linkedRepo,
      unlinkedRepo,
      ownerInstallations,
      appPermissions: app?.permissions ?? null,
    },
  };
}

/**
 * Link a workspace to a synced repo row its team's installation already
 * covers — the same write `syncInstallationRepos` makes for every matching
 * workspace, for this one. Idempotent.
 */
async function linkWorkspaceToRepo(workspaceId: string, row: RepoRowFacts): Promise<void> {
  if (!row.installation) return;
  await db
    .update(workspaces)
    .set({ githubRepoId: row.id, githubInstallationId: row.installation.id, updatedAt: new Date() })
    .where(eq(workspaces.id, workspaceId));
}

export interface ResolvedRepoAccess {
  diagnosis: RepoAccessDiagnosis;
  /** True when the workspace was linked to an already-synced repo row on the way. */
  healed: boolean;
  teamId: string | null;
}

/**
 * Can Buildd perform `operation` on this workspace's repo? With `heal`, a
 * synced-but-unlinked repo is linked and re-judged, so the caller proceeds
 * instead of refusing on a state nobody has to change on GitHub.
 */
export async function resolveWorkspaceRepoAccess(
  workspaceId: string | null | undefined,
  operation: RepoAccessOperation,
  opts: { heal?: boolean } = {},
): Promise<ResolvedRepoAccess> {
  const loaded = workspaceId ? await loadRepoAccessFacts(workspaceId) : null;
  if (!loaded) {
    return {
      diagnosis: diagnoseRepoAccess({ appConfigured: isGitHubAppConfigured(), declaredRepo: null, linkedRepo: null, unlinkedRepo: null, ownerInstallations: [], appPermissions: null }, operation),
      healed: false,
      teamId: null,
    };
  }
  const diagnosis = diagnoseRepoAccess(loaded.facts, operation);
  if (opts.heal && !diagnosis.ok && diagnosis.problem.reason === 'workspace_not_linked' && diagnosis.problem.repoRow) {
    await linkWorkspaceToRepo(loaded.workspace.id, diagnosis.problem.repoRow);
    const relinked = { ...loaded.facts, linkedRepo: diagnosis.problem.repoRow, unlinkedRepo: null };
    return { diagnosis: diagnoseRepoAccess(relinked, operation), healed: true, teamId: loaded.workspace.teamId };
  }
  return { diagnosis, healed: false, teamId: loaded.workspace.teamId };
}

// ── Waiting tasks ───────────────────────────────────────────────────────────

/**
 * Stamp the task a refused PR operation came from, so the admin sees one
 * Needs You card and the task can be resumed once access is verified.
 * Returns whether this workspace was already waiting on GitHub access — the
 * agent is then told not to ask anyone again.
 */
export async function recordRepoAccessBlock(params: {
  taskId: string | null | undefined;
  workerId: string | null | undefined;
  workspaceId: string;
  problem: RepoAccessProblem;
  head?: string | null;
}): Promise<{ alreadyReported: boolean }> {
  const prior = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(
      eq(tasks.workspaceId, params.workspaceId),
      sql`${tasks.context} ? 'githubAccessBlock'`,
      sql`(${tasks.context}->'githubAccessBlock'->>'resumedAt') IS NULL`,
      gt(tasks.updatedAt, sql`NOW() - MAKE_INTERVAL(days => ${BLOCK_WINDOW_DAYS})`),
    ))
    .limit(1);

  if (params.taskId) {
    const block: GithubAccessBlock = {
      reason: params.problem.reason,
      operation: params.problem.operation,
      repo: params.problem.repoFullName,
      workerId: params.workerId ?? null,
      head: params.head ?? null,
      at: new Date().toISOString(),
      resumedAt: null,
    };
    await db
      .update(tasks)
      .set({
        context: sql`jsonb_set(coalesce(${tasks.context}, '{}'::jsonb), '{githubAccessBlock}', ${JSON.stringify(block)}::jsonb)`,
        updatedAt: new Date(),
      })
      .where(eq(tasks.id, params.taskId));
  }
  return { alreadyReported: prior.length > 0 };
}

export interface ResumeResult {
  /** Access verified for the PR operations the waiting tasks need. */
  verified: boolean;
  resumed: string[];
  diagnosis: RepoAccessDiagnosis;
  healed: boolean;
}

/**
 * Re-queue this workspace's tasks that failed waiting for GitHub access — but
 * only after access is verified for opening a PR, and only once per refusal:
 *
 *   - `status = 'failed'` guards the flip, so a repeated webhook or a second
 *     "Check connection" finds the task already pending and does nothing;
 *   - `resumedAt` is stamped on the block in the same UPDATE, so a task that
 *     fails again for an unrelated reason is not re-woken by this path.
 *
 * The next run's create_pr re-finds the PR for the same head on GitHub before
 * opening one, so a PR a person opened in the meantime is adopted, not
 * duplicated. Nothing here creates a repository.
 */
export async function resumeRepoAccessBlockedTasks(workspaceId: string): Promise<ResumeResult> {
  const { diagnosis, healed } = await resolveWorkspaceRepoAccess(workspaceId, 'pr.create', { heal: true });
  if (!diagnosis.ok) return { verified: false, resumed: [], diagnosis, healed };

  const now = new Date().toISOString();
  const rows = await db
    .update(tasks)
    .set({
      status: 'pending',
      context: sql`jsonb_set(${tasks.context}, '{githubAccessBlock,resumedAt}', to_jsonb(${now}::text))`,
      updatedAt: new Date(),
    })
    .where(and(
      inArray(
        tasks.id,
        db.select({ id: tasks.id }).from(tasks).where(and(
          eq(tasks.workspaceId, workspaceId),
          eq(tasks.status, 'failed'),
          sql`${tasks.context} ? 'githubAccessBlock'`,
          sql`(${tasks.context}->'githubAccessBlock'->>'resumedAt') IS NULL`,
          gt(tasks.updatedAt, sql`NOW() - MAKE_INTERVAL(days => ${BLOCK_WINDOW_DAYS})`),
        )).limit(MAX_RESUME),
      ),
      eq(tasks.status, 'failed'),
    ))
    .returning({ id: tasks.id });

  const resumed = rows.map(r => r.id);
  if (resumed.length > 0) {
    await wakeTasks(resumed, 'credential.restored');
    console.log(`[github-repo-access] resumed ${resumed.length} task(s) in workspace ${workspaceId} after GitHub access was verified`);
  }
  return { verified: true, resumed, diagnosis, healed };
}

/**
 * After an installation changed on GitHub (installed, repos added,
 * unsuspended, permissions accepted): resume waiting tasks in every workspace
 * whose repo lives on that account. Each workspace is re-verified on its own;
 * one whose repo is still excluded stays waiting. Never throws.
 */
export async function resumeAfterInstallationChange(installationId: number): Promise<string[]> {
  try {
    const inst = await db.query.githubInstallations.findFirst({
      where: eq(githubInstallations.installationId, installationId),
      columns: { accountLogin: true },
    });
    if (!inst) return [];
    const owner = inst.accountLogin.toLowerCase();

    const waiting = await db
      .selectDistinct({ workspaceId: tasks.workspaceId })
      .from(tasks)
      .where(and(
        eq(tasks.status, 'failed'),
        sql`${tasks.context} ? 'githubAccessBlock'`,
        sql`(${tasks.context}->'githubAccessBlock'->>'resumedAt') IS NULL`,
        gt(tasks.updatedAt, sql`NOW() - MAKE_INTERVAL(days => ${BLOCK_WINDOW_DAYS})`),
      ))
      .limit(200);
    const wsIds = waiting.map(w => w.workspaceId).filter((v): v is string => !!v);
    if (wsIds.length === 0) return [];

    const candidates = await db.query.workspaces.findMany({
      where: inArray(workspaces.id, wsIds),
      columns: { id: true, repo: true },
      with: { githubRepo: { columns: { fullName: true } } },
    });
    const resumed: string[] = [];
    for (const ws of candidates) {
      const repo = normalizeRepoFullName((ws.githubRepo as { fullName?: string } | null)?.fullName) ?? normalizeRepoFullName(ws.repo);
      if (!repo || repo.split('/')[0].toLowerCase() !== owner) continue;
      const r = await resumeRepoAccessBlockedTasks(ws.id);
      resumed.push(...r.resumed);
    }
    return resumed;
  } catch (err) {
    console.error(`[github-repo-access] resume after installation ${installationId} change failed:`, err);
    return [];
  }
}

// ── Manual check ────────────────────────────────────────────────────────────

/**
 * Re-read one installation from GitHub (permissions, repository selection,
 * suspension) — what a missed `installation` webhook would have written.
 * Returns false when GitHub no longer knows the installation.
 */
export async function refreshInstallationFromGitHub(installationId: number): Promise<boolean> {
  const res = await fetch(`https://api.github.com/app/installations/${installationId}`, {
    headers: {
      Authorization: `Bearer ${generateAppJWT()}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (res.status === 404) return false;
  if (!res.ok) throw new Error(`GitHub API error: ${res.status} ${await res.text()}`);
  const data = await res.json() as {
    permissions?: Record<string, string>;
    repository_selection?: 'all' | 'selected';
    suspended_at?: string | null;
    account?: { login?: string };
  };
  await db
    .update(githubInstallations)
    .set({
      ...(data.permissions ? { permissions: data.permissions } : {}),
      ...(data.repository_selection ? { repositorySelection: data.repository_selection } : {}),
      ...(data.account?.login ? { accountLogin: data.account.login } : {}),
      suspendedAt: data.suspended_at ? new Date(data.suspended_at) : null,
      updatedAt: new Date(),
    })
    .where(eq(githubInstallations.installationId, installationId));
  return true;
}

export interface CheckConnectionResult extends ResumeResult {
  refreshedInstallations: number;
}

/**
 * The manual "Check connection": the fallback when GitHub's webhook never
 * arrives. Re-reads every installation this workspace's team owns on the
 * repo's owner (plus the one it is linked to), mirrors their repos, re-judges
 * access and resumes waiting tasks if it is now verified. Safe to repeat.
 */
export async function checkWorkspaceRepoConnection(workspaceId: string): Promise<CheckConnectionResult> {
  const loaded = await loadRepoAccessFacts(workspaceId);
  let refreshed = 0;
  if (loaded && loaded.facts.appConfigured) {
    const insts = new Map<string, InstallationFacts>();
    if (loaded.facts.linkedRepo?.installation) insts.set(loaded.facts.linkedRepo.installation.id, loaded.facts.linkedRepo.installation);
    if (loaded.facts.unlinkedRepo?.installation) insts.set(loaded.facts.unlinkedRepo.installation.id, loaded.facts.unlinkedRepo.installation);
    for (const i of loaded.facts.ownerInstallations) insts.set(i.id, i);
    for (const inst of insts.values()) {
      try {
        if (!(await refreshInstallationFromGitHub(inst.installationId))) continue;
        await syncInstallationRepos({ id: inst.id, installationId: inst.installationId });
        refreshed++;
      } catch (err) {
        console.warn(`[github-repo-access] check connection: installation ${inst.installationId} refresh failed:`, err instanceof Error ? err.message : err);
      }
    }
  }
  const result = await resumeRepoAccessBlockedTasks(workspaceId);
  return { ...result, refreshedInstallations: refreshed };
}

/** How many of this workspace's tasks are failed waiting on GitHub access. */
export async function countWaitingTasks(workspaceId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(tasks)
    .where(and(
      eq(tasks.workspaceId, workspaceId),
      eq(tasks.status, 'failed'),
      isNull(tasks.parentTaskId),
      sql`${tasks.context} ? 'githubAccessBlock'`,
      sql`(${tasks.context}->'githubAccessBlock'->>'resumedAt') IS NULL`,
    ));
  return row?.n ?? 0;
}

// ── View for people ─────────────────────────────────────────────────────────

export interface RepoAccessView {
  ok: boolean;
  repo: string | null;
  remediation: RepoAccessRemediation | null;
  /** Tasks failed waiting on this access, resumed automatically once it is verified. */
  waitingTasks: number;
}

/**
 * What the workspace's "GitHub access" card shows this person. Read-only: no
 * heal, no sync — those are the Check connection button's job.
 */
export async function getRepoAccessView(workspaceId: string, viewerUserId: string | null): Promise<RepoAccessView> {
  const [{ diagnosis }, waitingTasks, viewerRow] = await Promise.all([
    resolveWorkspaceRepoAccess(workspaceId, 'pr.create'),
    countWaitingTasks(workspaceId),
    viewerUserId
      ? db.query.users.findFirst({ where: eq(users.id, viewerUserId), columns: { id: true, githubId: true } })
      : Promise.resolve(null),
  ]);
  if (diagnosis.ok) return { ok: true, repo: diagnosis.repo.fullName, remediation: null, waitingTasks };
  const app = await getGitHubAppIdentity();
  const remediation = describeRepoAccessProblem(diagnosis.problem, {
    app,
    viewer: viewerRow ? { userId: viewerRow.id, githubId: viewerRow.githubId ?? null } : null,
    // Buildd's own install flow signs the session into the state, so the
    // callback can attribute the installation to this team. Only offered when
    // the App's real identity is known.
    installFlowUrl: app ? `/api/github/install?returnUrl=${encodeURIComponent(repoAccessSettingsPath(workspaceId).split('#')[0])}` : null,
  });
  return { ok: false, repo: diagnosis.problem.repoFullName, remediation, waitingTasks };
}
