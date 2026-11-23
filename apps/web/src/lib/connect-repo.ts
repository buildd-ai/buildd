/**
 * The connect-repo page (`/app/connect-repo?repo=<owner/name>&runner=<account id>`):
 * where `buildd acp` sends a person whose T3 project matched no workspace the
 * runner reaches (apps/runner/src/acp/bridge.ts, startTask). It works out why
 * and offers one fix:
 *
 *  - a workspace for the repo is in one of the person's teams and the runner
 *    is not picked for it: add the pick (lib/runner-picks.ts addRunnerPick,
 *    the same path and checks as Settings' Edit);
 *  - no workspace for the repo: create one in a team the person may create
 *    in, through the GitHub installation that team owns
 *    (lib/workspace-create.ts, the code behind POST /api/workspaces), then pick
 *    the runner for it;
 *  - the runner already reaches it: say so.
 *
 * Session only. A runner key never reaches this file: picks are a person's
 * (spec "One runner for every team you run", R-8), and the runner learns
 * nothing about workspaces it cannot already see. The runner id in the URL
 * grants nothing: a key the person did not mint reads as not found.
 */
import { createHmac, timingSafeEqual } from 'crypto';
import { and, count, desc, eq, ne, sql } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { accounts, githubInstallations, teamMembers, teams, workerHeartbeats, workspaces } from '@buildd/core/db/schema';
import { decideTaskIsolation, readIsolationRecord, resolveIsolationRequirement, type RunnerIsolationRecord } from '@buildd/shared';
import { consentTeamsForUser } from './mcp-grant-admin';
import { runnerPickerTeams } from './runner-picks-plan';
import { addRunnerPick, listRunnerKeys, type RunnerKeySummary } from './runner-picks';
import { normalizeRepoFullName } from './repo-scope';
import { teamInstallationIdForOwner } from './workspace-installation';
import { githubApi } from './github';
import { can } from './permissions';
import { createWorkspace } from './workspace-create';
import { getJwtSecret } from './oauth/config';

export interface ConnectWorkspace {
  id: string;
  name: string;
  teamId: string;
  teamName: string;
  /**
   * Set when this runner cannot serve the workspace's isolation requirement but
   * would, were the workspace set to trusted local. `canFix`: the person may
   * change the workspace's settings, so the page may offer that one confirm.
   */
  isolationBlocked?: { canFix: boolean };
}

export interface ConnectTeam {
  id: string;
  name: string;
}

export type ConnectRepoCase =
  | { kind: 'bad_request'; message: string }
  | { kind: 'key_not_found' }
  /** A team's runner key (not a person's) in one of the person's teams: it only ever works in that team's workspaces. */
  | { kind: 'team_key'; runnerName: string; teamName: string }
  /** The runner already reaches a workspace for this repo. */
  | { kind: 'already'; runnerName: string; workspace: ConnectWorkspace }
  /** Workspaces for this repo the person may pick for the runner. */
  | { kind: 'pick'; runnerName: string; workspaces: ConnectWorkspace[] }
  /** A workspace exists but this person cannot pick it; the message says who can. */
  | { kind: 'blocked'; runnerName: string; message: string }
  /** No workspace for this repo: teams the person may create it in, with a GitHub installation for its owner. */
  | { kind: 'create'; runnerName: string; teams: ConnectTeam[] }
  /** No workspace and no team with the GitHub App on the repo's owner. */
  | { kind: 'install_github'; runnerName: string }
  /** No workspace and no team the person may create one in. */
  | { kind: 'no_team'; runnerName: string };

/**
 * Whether a runner's last isolation probe cannot serve a workspace as it is
 * set now, yet could once the workspace is trusted local. The same resolution
 * and decision the claim's isolation gate makes (Claude, the default backend),
 * so the page and the claim agree. False when no change to the workspace would
 * help (that is the runner operator's to fix) and when it already serves.
 */
export function isolationFixableByPolicy(input: {
  workspacePolicy: unknown;
  accessMode: string | null;
  teamMemberCount: number | null;
  record: RunnerIsolationRecord | null;
}): boolean {
  const { requirement } = resolveIsolationRequirement({
    workspacePolicy: input.workspacePolicy,
    workspaceAccessMode: input.accessMode,
    teamMemberCount: input.teamMemberCount,
  });
  if (requirement !== 'protected') return false;
  const base = { record: input.record, backend: 'claude' as const, codexMode: 'workspace-write' as const };
  return !decideTaskIsolation({ ...base, requirement }).ok && decideTaskIsolation({ ...base, requirement: 'trusted_local' }).ok;
}

/** The runner's last isolation probe, from its newest heartbeat. */
async function runnerIsolationRecord(accountId: string): Promise<RunnerIsolationRecord | null> {
  const [hb] = await db
    .select({ isolation: sql<unknown>`${workerHeartbeats.environment}->'isolation'` })
    .from(workerHeartbeats)
    .where(eq(workerHeartbeats.accountId, accountId))
    .orderBy(desc(workerHeartbeats.lastHeartbeatAt))
    .limit(1);
  return readIsolationRecord({ isolation: hb?.isolation });
}

/** `w` with `isolationBlocked` set when this runner cannot serve it as it is configured. */
async function withIsolation(userId: string, accountId: string, list: ConnectWorkspace[]): Promise<ConnectWorkspace[]> {
  if (list.length === 0) return list;
  const record = await runnerIsolationRecord(accountId);
  const out: ConnectWorkspace[] = [];
  for (const w of list) {
    const [row] = await db
      .select({ gitConfig: workspaces.gitConfig, accessMode: workspaces.accessMode })
      .from(workspaces)
      .where(eq(workspaces.id, w.id));
    const policy = (row?.gitConfig as { isolationPolicy?: unknown } | null | undefined)?.isolationPolicy;
    let members: number | null = null;
    if (policy === undefined) {
      const [c] = await db.select({ n: count() }).from(teamMembers).where(eq(teamMembers.teamId, w.teamId));
      members = c ? Number(c.n) : null;
    }
    const blocked = isolationFixableByPolicy({ workspacePolicy: policy, accessMode: row?.accessMode ?? null, teamMemberCount: members, record });
    out.push(blocked ? { ...w, isolationBlocked: { canFix: await can({ kind: 'user', userId }, 'manage_workspace_settings', w.teamId) } } : w);
  }
  return out;
}

const sameRepo = (a: string | null | undefined, repo: string) =>
  (normalizeRepoFullName(a) ?? '').toLowerCase() === repo.toLowerCase();

/**
 * Teams the person may create a workspace in, with the installation each would
 * link through: the one on the repo's owner that the team owns
 * (teamInstallationIdForOwner, the team-scoped lookup).
 */
async function creatableTeams(userId: string, owner: string): Promise<{ teams: Array<ConnectTeam & { installationDbId: string; installationId: number }>; anyCreatable: boolean }> {
  const memberships = await db
    .select({ id: teams.id, name: teams.name })
    .from(teamMembers)
    .innerJoin(teams, eq(teams.id, teamMembers.teamId))
    .where(eq(teamMembers.userId, userId));
  const allowed: ConnectTeam[] = [];
  for (const t of memberships) {
    if (await can({ kind: 'user', userId }, 'create_workspace', t.id)) allowed.push(t);
  }
  if (allowed.length === 0) return { teams: [], anyCreatable: false };

  const out: Array<ConnectTeam & { installationDbId: string; installationId: number }> = [];
  for (const t of allowed) {
    const installationId = await teamInstallationIdForOwner(owner, t.id);
    if (installationId == null) continue;
    const [row] = await db
      .select({ id: githubInstallations.id })
      .from(githubInstallations)
      .where(eq(githubInstallations.installationId, installationId));
    if (row) out.push({ ...t, installationDbId: row.id, installationId });
  }
  return { teams: out, anyCreatable: true };
}

/** What the page shows for this person, runner and repo. */
export async function resolveConnectRepo(args: { userId: string; accountId: string; repo: string }): Promise<ConnectRepoCase> {
  const repo = normalizeRepoFullName(args.repo);
  if (!repo) return { kind: 'bad_request', message: 'The link names no GitHub repo (owner/name).' };
  const key = (await listRunnerKeys(args.userId)).find((k) => k.id === args.accountId);
  if (!key) return (await teamKeyOf(args.userId, args.accountId)) ?? { kind: 'key_not_found' };
  return resolveForKey(args.userId, key, repo);
}

/**
 * A runner key that is not a person's: a team's own key, named only when the person is in that
 * team (otherwise it reads as not found, like anyone else's key). Nothing here adds a workspace to
 * it: a team key works only in its own team's workspaces, which that team's admins manage, and a
 * machine that works across a person's teams runs on that person's key (spec "One runner for every
 * team you run", R-8).
 */
async function teamKeyOf(userId: string, accountId: string): Promise<ConnectRepoCase | null> {
  const [row] = await db
    .select({ name: accounts.name, teamName: teams.name })
    .from(accounts)
    .innerJoin(teams, eq(teams.id, accounts.teamId))
    .innerJoin(teamMembers, eq(teamMembers.teamId, accounts.teamId))
    .where(and(eq(accounts.id, accountId), ne(accounts.type, 'user'), eq(teamMembers.userId, userId)));
  return row ? { kind: 'team_key', runnerName: row.name, teamName: row.teamName } : null;
}

async function resolveForKey(userId: string, key: RunnerKeySummary, repo: string): Promise<ConnectRepoCase> {
  const runnerName = key.name;
  const personTeams = await consentTeamsForUser(userId);
  const matches: ConnectWorkspace[] = personTeams.flatMap((t) =>
    t.workspaces.filter((w) => !w.system && sameRepo(w.repo, repo)).map((w) => ({ id: w.id, name: w.name, teamId: t.id, teamName: t.name })));
  const offered = new Set(runnerPickerTeams(personTeams).flatMap((t) => t.workspaces.map((w) => w.id)));

  if (key.picks == null) {
    // A key from before picks reaches its home team's workspaces.
    const home = matches.find((w) => w.teamId === key.homeTeamId && offered.has(w.id));
    if (home) return { kind: 'already', runnerName, workspace: (await withIsolation(userId, key.id, [home]))[0] };
    return { kind: 'blocked', runnerName, message: `${runnerName} was set up before runners picked workspaces. Run buildd login on it to make a key that can work on ${repo}.` };
  }

  const reached = matches.find((w) => key.picks!.some((p) => p.workspaceId === w.id && p.reachable));
  if (reached) return { kind: 'already', runnerName, workspace: (await withIsolation(userId, key.id, [reached]))[0] };

  const removed = new Set(key.picks.filter((p) => p.removedByAdmin).map((p) => p.workspaceId));
  const pickable = matches.filter((w) => offered.has(w.id) && !removed.has(w.id));
  if (pickable.length > 0) return { kind: 'pick', runnerName, workspaces: await withIsolation(userId, key.id, pickable) };

  if (matches.length > 0) {
    const w = matches[0];
    const message = removed.has(w.id)
      ? `A team admin of ${w.teamName} removed ${runnerName} from ${w.name}. Ask them to add it back.`
      : `${w.name} in ${w.teamName} is restricted. A team owner or admin can let ${runnerName} work on it.`;
    return { kind: 'blocked', runnerName, message };
  }

  const { teams: creatable, anyCreatable } = await creatableTeams(userId, repo.split('/')[0]);
  if (creatable.length > 0) return { kind: 'create', runnerName, teams: creatable.map(({ id, name }) => ({ id, name })) };
  return anyCreatable ? { kind: 'install_github', runnerName } : { kind: 'no_team', runnerName };
}

/** Sets the workspace's isolation policy to trusted_local, only where the page offered it (a blocked workspace its person may change). */
async function setTrustedLocal(w: ConnectWorkspace): Promise<boolean> {
  if (!w.isolationBlocked?.canFix) return false;
  await db
    .update(workspaces)
    .set({ gitConfig: sql`coalesce(${workspaces.gitConfig}, '{}'::jsonb) || '{"isolationPolicy":"trusted_local"}'::jsonb`, updatedAt: new Date() })
    .where(eq(workspaces.id, w.id));
  return true;
}

export type ConfirmResult =
  | { ok: true; runnerName: string; workspaceName: string; created: boolean; isolationSet?: boolean }
  | { ok: false; status: 400 | 403 | 404 | 409 | 502; message: string };

/**
 * The page's confirm button. The case is worked out again from scratch, and
 * the chosen workspace or team must be one it offers now.
 */
export async function confirmConnectRepo(args: {
  userId: string;
  accountId: string;
  repo: string;
  workspaceId?: string | null;
  teamId?: string | null;
  /** The person confirmed setting the workspace to trusted local (only honoured where the page offered it). */
  trustLocal?: boolean;
  origin: string;
}): Promise<ConfirmResult> {
  const repo = normalizeRepoFullName(args.repo);
  if (!repo) return { ok: false, status: 400, message: 'The link names no GitHub repo (owner/name).' };
  const key = (await listRunnerKeys(args.userId)).find((k) => k.id === args.accountId);
  if (!key) return { ok: false, status: 404, message: 'Runner not found.' };
  const found = await resolveForKey(args.userId, key, repo);

  if (found.kind === 'already') {
    const isolationSet = args.trustLocal ? await setTrustedLocal(found.workspace) : false;
    return { ok: true, runnerName: found.runnerName, workspaceName: found.workspace.name, created: false, ...(isolationSet ? { isolationSet } : {}) };
  }

  if (found.kind === 'pick') {
    const ws = found.workspaces.find((w) => w.id === args.workspaceId) ?? (found.workspaces.length === 1 && !args.workspaceId ? found.workspaces[0] : null);
    if (!ws) return { ok: false, status: 403, message: 'That workspace is not one you can pick for this runner.' };
    const r = await addRunnerPick({ accountId: key.id, userId: args.userId, workspaceId: ws.id });
    if (!r.ok) return { ok: false, status: r.status, message: r.message };
    const isolationSet = args.trustLocal ? await setTrustedLocal(ws) : false;
    return { ok: true, runnerName: found.runnerName, workspaceName: ws.name, created: false, ...(isolationSet ? { isolationSet } : {}) };
  }

  if (found.kind === 'create') {
    const team = found.teams.find((t) => t.id === args.teamId) ?? (found.teams.length === 1 && !args.teamId ? found.teams[0] : null);
    if (!team) return { ok: false, status: 403, message: 'You cannot create a workspace in that team.' };
    const { teams: withInstall } = await creatableTeams(args.userId, repo.split('/')[0]);
    const target = withInstall.find((t) => t.id === team.id);
    if (!target) return { ok: false, status: 403, message: 'You cannot create a workspace in that team.' };

    let gh: Record<string, unknown>;
    try {
      gh = await githubApi(target.installationId, `/repos/${repo}`);
    } catch {
      return { ok: false, status: 502, message: `The buildd GitHub App cannot see ${repo}. Add the repo to the App's access on GitHub, then reload this page.` };
    }
    const fullName = String(gh.full_name ?? repo);
    const created = await createWorkspace({
      teamId: team.id,
      name: String(gh.name ?? repo.split('/')[1]),
      repoUrl: fullName,
      githubRepo: {
        repoId: gh.id as number,
        fullName,
        name: String(gh.name ?? ''),
        owner: String((gh.owner as { login?: string } | undefined)?.login ?? repo.split('/')[0]),
        private: gh.private === true,
        defaultBranch: typeof gh.default_branch === 'string' ? gh.default_branch : 'main',
        htmlUrl: typeof gh.html_url === 'string' ? gh.html_url : null,
        description: typeof gh.description === 'string' ? gh.description : null,
      },
      githubInstallationId: target.installationDbId,
      knowledgeIngest: true,
      origin: args.origin,
      userId: args.userId,
    });
    if (!created.ok) return { ok: false, status: created.status, message: created.error };
    const r = await addRunnerPick({ accountId: key.id, userId: args.userId, workspaceId: created.workspace.id });
    if (!r.ok) {
      return { ok: false, status: r.status, message: `Created ${created.workspace.name}, but could not let ${found.runnerName} work on it: ${r.message}` };
    }
    return { ok: true, runnerName: found.runnerName, workspaceName: created.workspace.name, created: true };
  }

  if (found.kind === 'bad_request') return { ok: false, status: 400, message: found.message };
  if (found.kind === 'key_not_found') return { ok: false, status: 404, message: 'Runner not found.' };
  if (found.kind === 'team_key') return { ok: false, status: 409, message: `${found.runnerName} is ${found.teamName}'s runner key; it cannot be given other workspaces here.` };
  if (found.kind === 'blocked') return { ok: false, status: 403, message: found.message };
  return { ok: false, status: 409, message: 'There is nothing to confirm here yet.' };
}

// ── Form token ───────────────────────────────────────────────────────────────

const TOKEN_TTL_S = 60 * 60;

function mac(userId: string, accountId: string, repo: string, issuedAt: number): string {
  return createHmac('sha256', getJwtSecret()).update(`connect-repo\n${userId}\n${accountId}\n${repo.toLowerCase()}\n${issuedAt}`).digest('base64url');
}

/** Binds the confirm form to the person, runner and repo it was shown for. */
export function createConnectToken(userId: string, accountId: string, repo: string, now = Date.now()): string {
  const issuedAt = Math.floor(now / 1000);
  return `${issuedAt}.${mac(userId, accountId, repo, issuedAt)}`;
}

export function verifyConnectToken(token: string | null, userId: string, accountId: string, repo: string, now = Date.now()): boolean {
  if (!token) return false;
  const [raw, given] = token.split('.');
  const issuedAt = Number(raw);
  if (!Number.isInteger(issuedAt) || !given) return false;
  const age = Math.floor(now / 1000) - issuedAt;
  if (age < 0 || age > TOKEN_TTL_S) return false;
  const want = Buffer.from(mac(userId, accountId, repo, issuedAt));
  const got = Buffer.from(given);
  return want.length === got.length && timingSafeEqual(want, got);
}
