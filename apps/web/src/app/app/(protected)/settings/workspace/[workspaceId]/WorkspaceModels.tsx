import ModelProvidersClient from '../../providers/ModelProvidersClient';
import { loadSettingsContext } from '../../_lib/settings-context';
import { NO_PERMISSIONS, teamIdsHolding } from '../../_lib/settings-permissions';

/**
 * Settings › Workspace › Models: this workspace's own model keys and sign-ins,
 * the one place a workspace override is set (the team Models page only names
 * which workspaces have one). "Uses team settings" until an admin overrides.
 */
export default async function WorkspaceModels({ workspaceId, teamId }: { workspaceId: string; teamId: string }) {
  const { workspaces, permsByTeam } = await loadSettingsContext();
  const perms = permsByTeam[teamId] ?? NO_PERMISSIONS;
  const teamWorkspaces = workspaces.filter((w) => w.teamId === teamId);
  return (
    <ModelProvidersClient
      teamId={teamId}
      scope="workspace"
      workspaceId={workspaceId}
      isAdmin={perms.manage_inference_providers}
      workspaces={teamWorkspaces.map((w) => ({ id: w.id, name: w.name }))}
      signIns={{
        workspaces,
        currentTeamId: teamId,
        manageableTeamIds: teamIdsHolding(permsByTeam, 'manage_team_credentials'),
        canManage: perms.manage_team_credentials,
        canManageRouting: perms.manage_team_settings,
      }}
    />
  );
}
