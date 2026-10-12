import { consentTeamsForUser, listUserConnections } from '@/lib/mcp-grant-admin';
import SettingsPage from '../_components/SettingsPage';
import { loadSettingsContext } from '../_lib/settings-context';
import ConnectionsSection from './ConnectionsSection';
import TeamAppsSection from './connectors/TeamAppsSection';
import AgentAccessSection from './connectors/AgentAccessSection';

export const dynamic = 'force-dynamic';

/**
 * Settings → Connected apps, in two halves that mean different things.
 *
 * Your apps: the person's own MCP connections to buildd (lib/mcp-grant-admin.ts)
 * and the workspaces each reaches. Personal, not team-scoped: a connection can
 * span every team the person is on, so it is read for the signed-in user only.
 *
 * The team's: Team apps, the outside tools the active team's agents can call
 * (one row per app: catalog entry and installed connector together), and
 * Agent access, what agents asked for and the policy that answers
 * (`?request=<id>` focuses one request). A member reads both and can request
 * an app; a team admin changes them in each row's details. Each control
 * follows manage_connectors in the active team, and the API refuses the same
 * writes. next.config redirects /app/connections and the old
 * /app/settings/connectors here with their query, so the OAuth callback's
 * `?connected=` and `?error=` still arrive.
 */
export default async function ConnectionsSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ connected?: string; error?: string; request?: string }>;
}) {
  const [{ user, currentTeamId, workspaces }, { connected, error, request }] = await Promise.all([
    loadSettingsContext(),
    searchParams,
  ]);
  const [{ connections, legacy }, consentTeams] = await Promise.all([
    listUserConnections(user.id),
    consentTeamsForUser(user.id),
  ]);
  const teamWorkspaces = workspaces.filter((ws) => ws.teamId === currentTeamId).map((ws) => ({ id: ws.id, name: ws.name }));
  return (
    <SettingsPage
      title="Connected apps"
      description="Apps you connected to buildd, and the outside tools your team's agents can call."
    >
      <ConnectionsSection initial={{ connections, legacy, teams: consentTeams }} />
      <TeamAppsSection teamId={currentTeamId} workspaces={teamWorkspaces} connectedId={connected} errorMsg={error} />
      <AgentAccessSection teamId={currentTeamId} workspaces={teamWorkspaces} focusRequestId={request ?? null} />
    </SettingsPage>
  );
}
