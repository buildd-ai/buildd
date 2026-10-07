import SettingsPage from '../_components/SettingsPage';
import ConnectorsSection from '../ConnectorsSection';
import ConnectionsClient from './ConnectionsClient';
import CatalogSection from './CatalogSection';
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
    >
      <ConnectionsClient connectedId={connected} errorMsg={error} embedded />
      <ConnectorsSection
        workspaces={workspaces.map((ws) => ({ id: ws.id, name: ws.name }))}
        teams={teams.map((t) => ({ id: t.id, name: t.name }))}
        currentTeamId={currentTeamId}
      />
      <CatalogSection />
    </SettingsPage>
  );
}
