import SettingsPage from '../_components/SettingsPage';
import { loadSettingsContext } from '../_lib/settings-context';
import TeamAppsSection from '../connections/connectors/TeamAppsSection';
import AgentAccessSection from '../connections/connectors/AgentAccessSection';

export const dynamic = 'force-dynamic';

/**
 * Settings › Team › Apps: Team apps, the outside tools the active team's
 * agents can call (one row per app: catalog entry and installed connector
 * together), and Agent access, what agents asked for and the policy that
 * answers (`?request=<id>` focuses one request). A member reads both and can
 * request an app; a team admin changes them in each row's details. Each
 * control follows manage_connectors in the active team, and the API refuses
 * the same writes. The connector OAuth callback lands here with `?connected=`
 * or `?error=`; your own connected apps are Settings › You › Connected apps.
 */
export default async function TeamAppsSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ connected?: string; error?: string; request?: string }>;
}) {
  const [{ currentTeamId, workspaces }, { connected, error, request }] = await Promise.all([
    loadSettingsContext(),
    searchParams,
  ]);
  const teamWorkspaces = workspaces.filter((ws) => ws.teamId === currentTeamId).map((ws) => ({ id: ws.id, name: ws.name }));
  return (
    <SettingsPage title="Apps">
      <TeamAppsSection teamId={currentTeamId} workspaces={teamWorkspaces} connectedId={connected} errorMsg={error} />
      <AgentAccessSection teamId={currentTeamId} workspaces={teamWorkspaces} focusRequestId={request ?? null} />
    </SettingsPage>
  );
}
