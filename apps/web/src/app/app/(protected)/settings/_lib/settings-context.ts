import { cache } from 'react';
import { db } from '@buildd/core/db';
import { accounts, workerHeartbeats, workspaces } from '@buildd/core/db/schema';
import { desc, inArray, sql } from 'drizzle-orm';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth-helpers';
import { getUserWorkspaceIds, getUserTeamsWithDetails, resolveActiveTeamId, type UserTeam } from '@/lib/team-access';
import { isSystemWorkspace } from '@buildd/shared';
import { roleHas } from '@/lib/permission-registry';

export interface SettingsWorkspace {
  id: string;
  name: string;
  repo: string | null;
  teamId: string;
}

export interface SettingsContext {
  user: NonNullable<Awaited<ReturnType<typeof getCurrentUser>>>;
  teams: UserTeam[];
  currentTeamId: string | null;
  currentTeam: UserTeam | null;
  /** Owner or admin of the active team (a personal team counts as owner). */
  isTeamAdmin: boolean;
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

  const [teams, wsIds] = await Promise.all([
    getUserTeamsWithDetails(user.id).catch((e) => {
      console.error('Settings: teams query error:', e);
      return [] as UserTeam[];
    }),
    getUserWorkspaceIds(user.id).catch(() => [] as string[]),
  ]);

  // The same resolver the shell, Home and chat use (cookie, else
  // pickDefaultTeam), so a settings section can never act on a different team
  // than the header shows. `teams[0]` used to stand in for the default here.
  const teamCookie = (await cookies()).get('buildd-team')?.value;
  const currentTeamId = await resolveActiveTeamId(user.id, teamCookie).catch(() => null);
  const currentTeam = teams.find((t) => t.id === currentTeamId) ?? null;
  const isTeamAdmin = !!currentTeam && (
    roleHas(currentTeam.role, 'manage_team_settings') || currentTeam.slug === `personal-${user.id}`
  );

  const rows = wsIds.length > 0
    ? await db.query.workspaces.findMany({
        where: inArray(workspaces.id, wsIds),
        columns: { id: true, name: true, repo: true, teamId: true },
      }).catch(() => [] as SettingsWorkspace[])
    : [];

  return {
    user,
    teams,
    currentTeamId,
    currentTeam,
    isTeamAdmin,
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
  team: { name: string } | null;
  accountWorkspaces: { workspaceId: string }[];
}

/** Runner accounts (tokens) across the user's teams, for the Runners section. */
export async function loadRunnerAccounts(teamIds: string[]): Promise<RunnerAccountDto[]> {
  if (teamIds.length === 0) return [];
  const rows = await db.query.accounts.findMany({
    where: inArray(accounts.teamId, teamIds),
    orderBy: desc(accounts.createdAt),
    columns: RUNNER_ACCOUNT_COLUMNS,
    with: {
      team: { columns: { name: true } },
      accountWorkspaces: { columns: { workspaceId: true } },
    },
  }).catch(() => [] as never[]);
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
