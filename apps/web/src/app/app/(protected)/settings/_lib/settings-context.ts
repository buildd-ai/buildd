import { cache } from 'react';
import { db } from '@buildd/core/db';
import { accounts, workerHeartbeats, workspaces } from '@buildd/core/db/schema';
import { desc, eq, inArray, sql } from 'drizzle-orm';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth-helpers';
import { getUserWorkspaceIds, getUserTeamsWithDetails, resolveActiveTeamId, type UserTeam } from '@/lib/team-access';
import {
  isSystemWorkspace,
  isRunnerModelAuthSource,
  isRunnerCodexAuthSource,
  type RunnerModelAuthSource,
  type RunnerCodexAuthSource,
} from '@buildd/shared';
import { settingsPermissions, type SettingsPermissions } from './settings-permissions';
import { sqlOrderBy, sqlWhere } from '@buildd/core/db/relational-sql';
import { RUNNER_ONLINE_WINDOW_MS } from '@/lib/runner-heartbeats-shared';
import { cachedTeamRead } from '@/lib/team-cache';
import { callerDep } from '@/lib/caller-cache';

export interface SettingsWorkspace {
  id: string;
  name: string;
  repo: string | null;
  teamId: string;
  /** 'open': every key of the owning team reaches it; 'restricted': linked keys only. */
  accessMode: string | null;
}

export interface SettingsContext {
  user: NonNullable<Awaited<ReturnType<typeof getCurrentUser>>>;
  teams: UserTeam[];
  currentTeamId: string | null;
  currentTeam: UserTeam | null;
  /**
   * What the person may do in the active team, one flag per named permission:
   * exactly what the API would accept from
   * this session. A personal team counts as owned. All false with no team.
   */
  perms: SettingsPermissions;
  /** The same flags for every team the person is in, by team id. */
  permsByTeam: Readonly<Record<string, SettingsPermissions>>;
  workspaces: SettingsWorkspace[];
}

/**
 * What every settings section needs: the signed-in user, their teams, the
 * active team (resolveActiveTeamId: the `buildd-team` cookie, else the shell's default) and the
 * workspaces they can see. Each read degrades to empty on failure so one bad
 * query blanks a section, not the page. Cached per request.
 */
export const loadSettingsContext = cache(async (): Promise<SettingsContext> => {
  const user = await getCurrentUser();
  if (!user) redirect('/app/auth/signin');

  // The same resolver the shell, Home and chat use (cookie, else
  // pickDefaultTeam), so a settings section can never act on a different team
  // than the header shows. `teams[0]` used to stand in for the default here.
  // Independent reads go out together: the teams, the active team, and the
  // workspaces (their ids, then their rows).
  const teamCookie = (await cookies()).get('buildd-team')?.value;
  const [teams, currentTeamId, rows] = await Promise.all([
    getUserTeamsWithDetails(user.id).catch((e) => {
      console.error('Settings: teams query error:', e);
      return [] as UserTeam[];
    }),
    resolveActiveTeamId(user.id, teamCookie).catch(() => null),
    getUserWorkspaceIds(user.id).catch(() => [] as string[]).then((wsIds) => (wsIds.length > 0
      ? db.query.workspaces.findMany({
          where: sqlWhere(inArray(workspaces.id, wsIds)),
          columns: { id: true, name: true, repo: true, teamId: true, accessMode: true },
        }).catch(() => [] as SettingsWorkspace[])
      : [] as SettingsWorkspace[])),
  ]);
  const currentTeam = teams.find((t) => t.id === currentTeamId) ?? null;
  const permsByTeam: Record<string, SettingsPermissions> = {};
  for (const t of teams) permsByTeam[t.id] = settingsPermissions(t, user.id);
  const perms = settingsPermissions(currentTeam, user.id);

  return {
    user,
    teams,
    currentTeamId,
    currentTeam,
    perms,
    permsByTeam,
    workspaces: (rows as SettingsWorkspace[]).filter((ws) => !isSystemWorkspace(ws.name)),
  };
});

/**
 * The account columns the Runners section (RunnerTokensSection) renders, and
 * nothing else: this goes to a client component, so a column not listed here
 * never leaves the server.
 */
export const RUNNER_ACCOUNT_COLUMNS = {
  id: true,
  name: true,
  type: true,
  authType: true,
  apiKeyPrefix: true,
  maxConcurrentWorkers: true,
  totalCost: true,
  activeSessions: true,
  maxConcurrentSessions: true,
  budgetExhaustedAt: true,
  budgetResetsAt: true,
  createdAt: true,
  // The host-runner toggle: its state, and which team decides it.
  hostRunner: true,
  teamId: true,
  // Who minted it: they may delete it without manage_team_keys.
  createdByUserId: true,
} as const;

/** A runner account (token) as the Runners section receives it. */
export interface RunnerAccountDto {
  id: string;
  name: string;
  type: string;
  authType: string;
  apiKeyPrefix: string | null;
  maxConcurrentWorkers: number;
  totalCost: string | null;
  activeSessions: number | null;
  maxConcurrentSessions: number | null;
  budgetExhaustedAt: Date | string | null;
  budgetResetsAt: Date | string | null;
  createdAt: Date | string | null;
  hostRunner: boolean;
  teamId: string;
  createdByUserId: string | null;
  team: { name: string } | null;
  accountWorkspaces: { workspaceId: string }[];
}

/**
 * Runner accounts (tokens) across the user's teams, for the Runners section.
 * Each team's list comes from the per-team cache (lib/team-cache.ts: 30 s,
 * cleared when a runner or its workspace links change); newest first overall.
 */
export async function loadRunnerAccounts(teamIds: string[]): Promise<RunnerAccountDto[]> {
  if (teamIds.length === 0) return [];
  const lists = await Promise.all([...new Set(teamIds)].map(teamId =>
    cachedTeamRead(teamId, 'runners', () => loadTeamRunnerAccounts(teamId), {
      // A runner's links change through invalidateAccountWorkspaceCache, its row
      // through clearTeamCache(teamId, 'runners'): either ends the cached list.
      depsOf: list => list.map(a => callerDep.accountLinks(a.id)),
    }).then(list => list ?? [])));
  const time = (v: Date | string | null) => (v ? new Date(v).getTime() : 0);
  return lists.flat().sort((a, b) => time(b.createdAt) - time(a.createdAt));
}

/** One team's runner accounts, newest first; null (not cached) when the read fails. */
export async function loadTeamRunnerAccounts(teamId: string): Promise<RunnerAccountDto[] | null> {
  const rows = await db.query.accounts.findMany({
    where: sqlWhere(eq(accounts.teamId, teamId)),
    orderBy: sqlOrderBy(desc(accounts.createdAt)),
    columns: RUNNER_ACCOUNT_COLUMNS,
    with: {
      team: { columns: { name: true } },
      accountWorkspaces: { columns: { workspaceId: true } },
    },
  }).catch(() => null);
  if (!rows) return null;
  // Mapped field by field as well, so the DTO holds even if the query shape changes.
  return rows.map((a): RunnerAccountDto => ({
    id: a.id,
    name: a.name,
    type: a.type,
    authType: a.authType,
    apiKeyPrefix: a.apiKeyPrefix ?? null,
    maxConcurrentWorkers: a.maxConcurrentWorkers,
    totalCost: a.totalCost ?? null,
    activeSessions: a.activeSessions ?? null,
    maxConcurrentSessions: a.maxConcurrentSessions ?? null,
    budgetExhaustedAt: a.budgetExhaustedAt ?? null,
    budgetResetsAt: a.budgetResetsAt ?? null,
    createdAt: a.createdAt ?? null,
    hostRunner: a.hostRunner === true,
    teamId: a.teamId,
    createdByUserId: a.createdByUserId ?? null,
    team: a.team ? { name: a.team.name } : null,
    accountWorkspaces: (a.accountWorkspaces ?? []).map((w: { workspaceId: string }) => ({ workspaceId: w.workspaceId })),
  }));
}

/**
 * When each runner token last had a runner heartbeat, ISO. Heartbeat rows are
 * swept once they go stale, so a token missing here has not been seen
 * recently, which is not the same as never. Degrades to empty on failure.
 */
export async function loadAccountLastSeen(accountIds: string[]): Promise<Record<string, string>> {
  if (accountIds.length === 0) return {};
  const rows = await db
    .select({ accountId: workerHeartbeats.accountId, at: sql<Date | string>`max(${workerHeartbeats.lastHeartbeatAt})` })
    .from(workerHeartbeats)
    .where(inArray(workerHeartbeats.accountId, accountIds))
    .groupBy(workerHeartbeats.accountId)
    .catch(() => [] as Array<{ accountId: string; at: Date | string }>);
  const out: Record<string, string> = {};
  for (const r of rows) if (r.at) out[r.accountId] = new Date(r.at).toISOString();
  return out;
}

/** The model logins one runner token's latest heartbeat reported. */
export interface AccountModelAuth {
  claude: RunnerModelAuthSource | null;
  codex: RunnerCodexAuthSource | null;
}

/**
 * The model logins (Claude and Codex) each runner token's most recent
 * heartbeat reported (docs/specs/runner-model-login-detect-say-report.md). Null when that
 * runner never sends the field (older build), so the row says "not reported"
 * (Claude) or shows no Codex line, instead of guessing. Degrades to empty on
 * failure.
 */
export async function loadAccountModelAuth(accountIds: string[]): Promise<Record<string, AccountModelAuth>> {
  if (accountIds.length === 0) return {};
  const rows = await db
    .select({
      accountId: workerHeartbeats.accountId,
      source: workerHeartbeats.modelAuthSource,
      codex: workerHeartbeats.codexAuthSource,
    })
    .from(workerHeartbeats)
    .where(inArray(workerHeartbeats.accountId, accountIds))
    .orderBy(desc(workerHeartbeats.lastHeartbeatAt))
    .catch(() => [] as Array<{ accountId: string; source: string | null; codex: string | null }>);
  const out: Record<string, AccountModelAuth> = {};
  for (const r of rows) {
    if (r.accountId in out) continue;
    out[r.accountId] = {
      claude: isRunnerModelAuthSource(r.source) ? r.source : null,
      codex: isRunnerCodexAuthSource(r.codex) ? r.codex : null,
    };
  }
  return out;
}

/** One live runner of a token, with the slots it runs and where that number came from. */
export interface AccountRunnerSlots {
  id: string;
  /** The runner's own name (`buildd name`), else the host of its address. */
  name: string;
  online: boolean;
  active: number;
  reported: number;
  desired: number | null;
  origin: 'dashboard' | 'machine' | null;
  setBy: string | null;
  setAt: string | null;
}

/**
 * The runners (heartbeat rows) of each runner token, newest first, for the
 * per-runner slot control (spec 34a48877 R-5). Heartbeat rows are swept once
 * stale, so a token whose runner is gone has none. Degrades to empty on failure.
 */
export async function loadAccountRunnerSlots(accountIds: string[], now: number = Date.now()): Promise<Record<string, AccountRunnerSlots[]>> {
  if (accountIds.length === 0) return {};
  const rows = await db
    .select({
      id: workerHeartbeats.id,
      accountId: workerHeartbeats.accountId,
      localUiUrl: workerHeartbeats.localUiUrl,
      name: sql<string | null>`${workerHeartbeats.environment}->'labels'->>'name'`,
      lastHeartbeatAt: workerHeartbeats.lastHeartbeatAt,
      active: workerHeartbeats.activeWorkerCount,
      reported: workerHeartbeats.maxConcurrentWorkers,
      desired: workerHeartbeats.desiredSlots,
      origin: workerHeartbeats.desiredSlotsOrigin,
      setBy: workerHeartbeats.desiredSlotsSetBy,
      setAt: workerHeartbeats.desiredSlotsSetAt,
    })
    .from(workerHeartbeats)
    .where(inArray(workerHeartbeats.accountId, accountIds))
    .orderBy(desc(workerHeartbeats.lastHeartbeatAt))
    .catch(() => [] as never[]);
  const out: Record<string, AccountRunnerSlots[]> = {};
  for (const r of rows) {
    let host = r.localUiUrl;
    try { host = new URL(r.localUiUrl).hostname || r.localUiUrl; } catch { /* keep the address as sent */ }
    (out[r.accountId] ??= []).push({
      id: r.id,
      name: r.name || host,
      online: now - new Date(r.lastHeartbeatAt).getTime() <= RUNNER_ONLINE_WINDOW_MS,
      active: r.active,
      reported: r.reported,
      desired: r.desired ?? null,
      origin: r.origin ?? null,
      setBy: r.setBy ?? null,
      setAt: r.setAt ? new Date(r.setAt).toISOString() : null,
    });
  }
  return out;
}
