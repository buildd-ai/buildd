import { consentTeamsForUser, listUserConnections } from '@/lib/mcp-grant-admin';
import SettingsPage from '../_components/SettingsPage';
import ConnectorsSection from '../ConnectorsSection';
import { loadSettingsContext } from '../_lib/settings-context';
import { teamIdsHolding } from '../_lib/settings-permissions';
import ConnectionsSection from './ConnectionsSection';
import ConnectionsClient from './connectors/ConnectionsClient';
import CatalogSection from './connectors/CatalogSection';

export const dynamic = 'force-dynamic';

/**
 * Settings → Connected apps: every outside tool, in two halves.
 *
 * Yours: the person's own MCP connections to buildd (lib/mcp-grant-admin.ts).
 * Personal, not team-scoped: a connection can span every team the person is
 * on, so it is read for the signed-in user only.
 *
 * The team's: MCP connectors agents can call (add, share, delete), which
 * workspaces get each one, and the catalog. Each control follows
 * manage_connectors in the team it acts on, with that team's overrides: the
 * API refuses the same writes. next.config redirects /app/connections and the
 * old /app/settings/connectors here with their query, so the OAuth callback's
 * `?connected=` and the banner's `?reconnect=` still arrive.
 */
export default async function ConnectionsSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ connected?: string; error?: string }>;
}) {
  const [{ user, teams, currentTeamId, workspaces, perms, permsByTeam }, { connected, error }] = await Promise.all([
    loadSettingsContext(),
    searchParams,
  ]);
  const [{ connections, legacy }, consentTeams] = await Promise.all([
    listUserConnections(user.id),
    consentTeamsForUser(user.id),
  ]);
  return (
    <SettingsPage
      title="Connected apps"
      description="Apps you connected to buildd, and the outside tools your team's agents can call."
    >
      <ConnectionsSection initial={{ connections, legacy, teams: consentTeams }} />
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
