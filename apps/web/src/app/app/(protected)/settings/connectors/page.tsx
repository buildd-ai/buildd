import SettingsPage from '../_components/SettingsPage';
import ConnectorsSection from '../ConnectorsSection';
import ConnectionsClient from './ConnectionsClient';
import { loadSettingsContext } from '../_lib/settings-context';

export const dynamic = 'force-dynamic';

/**
 * Settings → Connections → MCP connectors. Was two places: /app/connections
 * (add, share, delete) and a Settings section (which workspaces get each one).
 * next.config redirects /app/connections here with its query, so the OAuth
 * callback's `?connected=` and the banner's `?reconnect=` still arrive.
 */
export default async function ConnectorsSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ connected?: string; error?: string }>;
}) {
  const [{ teams, currentTeamId, workspaces }, { connected, error }] = await Promise.all([
    loadSettingsContext(),
    searchParams,
  ]);

  return (
    <SettingsPage
      title="MCP connectors"
      description="Outside tools your agents can call through MCP. Add one, then choose which workspaces get it."
    >
      <ConnectionsClient connectedId={connected} errorMsg={error} embedded />
      <ConnectorsSection
        workspaces={workspaces.map((ws) => ({ id: ws.id, name: ws.name }))}
        teams={teams.map((t) => ({ id: t.id, name: t.name }))}
        currentTeamId={currentTeamId}
      />
    </SettingsPage>
  );
}
