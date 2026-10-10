import SettingsPage from '../_components/SettingsPage';
import ConnectorsSection from '../ConnectorsSection';
import ConnectionsClient from './ConnectionsClient';
import CatalogSection from './CatalogSection';
import { loadSettingsContext } from '../_lib/settings-context';
import { teamIdsHolding } from '../_lib/settings-permissions';
import { settingsReadOnly } from '@/lib/settings-nav';

export const dynamic = 'force-dynamic';

/**
 * Settings › Team › MCP connectors. Was two places: /app/connections
 * (add, share, delete) and a Settings section (which workspaces get each one).
 * next.config redirects /app/connections here with its query, so the OAuth
 * callback's `?connected=` and the banner's `?reconnect=` still arrive.
 */
export default async function ConnectorsSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ connected?: string; error?: string }>;
}) {
  const [{ teams, currentTeamId, workspaces, perms, permsByTeam }, { connected, error }] = await Promise.all([
    loadSettingsContext(),
    searchParams,
  ]);

  return (
    <SettingsPage title="MCP connectors" readOnly={settingsReadOnly('connectors', perms)}>
      {/* Each control follows manage_connectors in the team it acts on, with
          that team's overrides: the API refuses the same writes. */}
      <ConnectionsClient
        connectedId={connected}
        errorMsg={error}
        embedded
        teamId={currentTeamId}
        canManage={perms.manage_connectors}
      />
      <ConnectorsSection
        workspaces={workspaces.map((ws) => ({ id: ws.id, name: ws.name, teamId: ws.teamId }))}
        teams={teams.map((t) => ({ id: t.id, name: t.name }))}
        currentTeamId={currentTeamId}
        manageableTeamIds={teamIdsHolding(permsByTeam, 'manage_connectors')}
      />
      <CatalogSection />
    </SettingsPage>
  );
}
