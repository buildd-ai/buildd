import type { WorkspaceGitConfig } from '@buildd/core/db/schema';
import { resolveBranchStrategy } from '@buildd/core/branch-strategy';
import type { MergePolicy } from '@buildd/shared';
import { resolvePolicy } from '@/lib/merge-policy';
import type { UserTeam } from '@/lib/team-access';
import { roleHas, type Permission, type PermissionOverrides } from '@/lib/permission-registry';

export interface WorkspaceRow {
  id: string;
  name: string;
  teamId: string;
  teamName: string;
  gitWorkflow: string;
  mergePolicy: string;
  enforceGreenCI: boolean;
  /** Owner/admin of the workspace's team: gitConfig writes are admin-only. */
  canEdit: boolean;
  /** Admin here and on at least one other team (the precheck requires both). */
  canMove: boolean;
}

const BRANCH_LABEL = { 'mission-branch': 'Mission branch', direct: 'Direct' } as const;

const TIER_LABEL: Record<MergePolicy['tier'], string> = {
  'auto-threshold': 'Auto-threshold',
  'agent-review': 'Agent review',
  human: 'Human gate',
};

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

/**
 * One row per workspace for Settings → Workspaces. The labels are the values
 * the server applies (resolveBranchStrategy / resolvePolicy), not raw fields.
 */
export function buildWorkspaceRows({
  userId,
  teams,
  workspaces,
  overrides,
}: {
  userId: string;
  teams: UserTeam[];
  overrides: TeamOverrides;
  workspaces: Array<{ id: string; name: string; teamId: string; gitConfig: WorkspaceGitConfig | null }>;
}): { rows: WorkspaceRow[]; moveTeams: Array<{ id: string; name: string }> } {
  const adminTeams = teamsHolding(userId, teams, 'manage_workspace_settings', overrides);
  const adminIds = new Set(adminTeams.map((t) => t.id));
  const teamName = new Map(teams.map((t) => [t.id, t.name]));

  const rows = workspaces.map((ws): WorkspaceRow => {
    const canEdit = adminIds.has(ws.teamId);
    return {
      id: ws.id,
      name: ws.name,
      teamId: ws.teamId,
      teamName: teamName.get(ws.teamId) ?? 'Unknown team',
      gitWorkflow: BRANCH_LABEL[resolveBranchStrategy(ws.gitConfig)],
      mergePolicy: TIER_LABEL[resolvePolicy({ gitConfig: ws.gitConfig }).tier],
      enforceGreenCI: ws.gitConfig?.enforceGreenCI ?? false,
      canEdit,
      canMove: canEdit && adminTeams.length > 1,
    };
  });

  return { rows, moveTeams: adminTeams.map((t) => ({ id: t.id, name: t.name })) };
}
