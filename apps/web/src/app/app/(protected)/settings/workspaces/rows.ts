import type { WorkspaceGitConfig } from '@buildd/core/db/schema';
import { resolveBranchStrategy } from '@buildd/core/branch-strategy';
import { resolveWorkspaceExecutor, type MergePolicy } from '@buildd/shared';
import { resolvePolicy } from '@/lib/merge-policy';
import { resolveRunnerSize } from '@/lib/runner-size';
import type { UserTeam } from '@/lib/team-access';
import { roleHas, type Permission, type PermissionOverrides } from '@/lib/permission-registry';
import type { WorkspaceDiffer, WorkspaceRow } from './list-groups';

export type { WorkspaceDiffer, WorkspaceRow };

/** The per-workspace aggregate from activity.ts (one grouped query for the list). */
export interface WorkspaceActivity {
  lastTaskAt: string | Date | null;
  openTasks: number;
  stuckTasks: number;
  redPrs: number;
}

const BRANCH_LABEL = { 'mission-branch': 'Mission branch', direct: 'Direct' } as const;

const TIER_LABEL: Record<MergePolicy['tier'], string> = {
  'auto-threshold': 'Auto-threshold',
  'agent-review': 'Agent review',
  human: 'Human gate',
};

/**
 * What a workspace with no gitConfig gets: the values the server applies
 * (resolveBranchStrategy / resolvePolicy), shown once above the list.
 */
export const WORKSPACE_DEFAULTS = {
  gitWorkflow: BRANCH_LABEL[resolveBranchStrategy(null)],
  mergePolicy: TIER_LABEL[resolvePolicy({ gitConfig: null }).tier],
} as const;

/** Each team's permission overrides (getTeamsPermissionOverrides); a missing team = defaults. */
export type TeamOverrides = ReadonlyMap<string, PermissionOverrides>;

function teamsHolding(userId: string, teams: UserTeam[], permission: Permission, overrides: TeamOverrides): UserTeam[] {
  return teams.filter((t) => roleHas(t.role, permission, overrides.get(t.id) ?? null) || t.slug === `personal-${userId}`);
}

/**
 * Teams a workspace can be moved between, or null when it cannot move: the
 * precheck requires admin on the source and the destination, so the user must
 * administer the workspace's team and at least one other.
 */
export function moveTargets(
  userId: string,
  teams: UserTeam[],
  workspaceTeamId: string,
  overrides: TeamOverrides,
): Array<{ id: string; name: string }> | null {
  const admin = teamsHolding(userId, teams, 'migrate_workspace', overrides);
  if (admin.length < 2 || !admin.some((t) => t.id === workspaceTeamId)) return null;
  return admin.map((t) => ({ id: t.id, name: t.name }));
}

function differsFromDefault(id: string, gitConfig: WorkspaceGitConfig | null): WorkspaceDiffer[] {
  const out: WorkspaceDiffer[] = [];
  const gitWorkflow = BRANCH_LABEL[resolveBranchStrategy(gitConfig)];
  if (gitWorkflow !== WORKSPACE_DEFAULTS.gitWorkflow) {
    out.push({ key: 'gitWorkflow', label: gitWorkflow, href: `/app/workspaces/${id}/config` });
  }
  const mergePolicy = TIER_LABEL[resolvePolicy({ gitConfig }).tier];
  if (mergePolicy !== WORKSPACE_DEFAULTS.mergePolicy) {
    out.push({ key: 'mergePolicy', label: mergePolicy, href: `/app/settings/workspace/${id}` });
  }
  // enforceGreenCI: a task's PR gets fix rounds until its checks pass (tasks route).
  if (gitConfig?.enforceGreenCI === true) {
    out.push({ key: 'ciRetry', label: 'Fixes until CI passes', href: `/app/workspaces/${id}/config#ci-retry` });
  }
  return out;
}

function toIso(v: string | Date | null | undefined): string | null {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * One row per workspace for Settings → Workspaces. Labels are the values the
 * server applies, not raw fields. The runner size reads only what is stored
 * (explicit, or the sticky derivation), never the run reports, so the list
 * stays one query.
 */
export function buildWorkspaceRows({
  userId,
  teams,
  workspaces,
  overrides,
  activity,
}: {
  userId: string;
  teams: UserTeam[];
  overrides: TeamOverrides;
  workspaces: Array<{ id: string; name: string; teamId: string; gitConfig: WorkspaceGitConfig | null; webhookConfig: unknown }>;
  activity: ReadonlyMap<string, WorkspaceActivity>;
}): { rows: WorkspaceRow[]; moveTeams: Array<{ id: string; name: string }> } {
  const adminTeams = teamsHolding(userId, teams, 'manage_workspace_settings', overrides);
  const adminIds = new Set(adminTeams.map((t) => t.id));
  const teamName = new Map(teams.map((t) => [t.id, t.name]));

  const rows = workspaces.map((ws): WorkspaceRow => {
    const canEdit = adminIds.has(ws.teamId);
    const { executor } = resolveWorkspaceExecutor(
      ws.gitConfig as { executor?: unknown } | null,
      ws.webhookConfig as { enabled?: unknown; events?: unknown } | null,
    );
    const a = activity.get(ws.id);
    return {
      id: ws.id,
      name: ws.name,
      teamId: ws.teamId,
      teamName: teamName.get(ws.teamId) ?? 'Unknown team',
      differs: differsFromDefault(ws.id, ws.gitConfig),
      runsOn: { executor, size: executor === 'cloud' ? resolveRunnerSize({ gitConfig: ws.gitConfig, reports: [] }).size : null },
      lastActivityAt: toIso(a?.lastTaskAt),
      openTasks: Number(a?.openTasks ?? 0),
      health: { stuckTasks: Number(a?.stuckTasks ?? 0), redPrs: Number(a?.redPrs ?? 0) },
      canEdit,
      canMove: canEdit && adminTeams.length > 1,
    };
  });

  return { rows, moveTeams: adminTeams.map((t) => ({ id: t.id, name: t.name })) };
}

export { sortByActivity, isInactive, groupWorkspaceRows, INACTIVE_AFTER_DAYS, type WorkspaceGroup } from './list-groups';
