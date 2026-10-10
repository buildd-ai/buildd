import SettingsPage from '../_components/SettingsPage';
import GitHubSection from '../GitHubSection';
import VercelSection from '../VercelSection';
import { loadSettingsContext } from '../_lib/settings-context';
import { permsInAnyTeam, teamIdsHolding } from '../_lib/settings-permissions';
import { settingsReadOnly } from '@/lib/settings-nav';
import { loadDisconnectableInstallationIds } from './_lib/disconnectable';
import StorageSection from './StorageSection';

export const dynamic = 'force-dynamic';

/**
 * Settings › Team › Integrations: the services the team connects buildd to.
 * GitHub (repository access), Vercel (preview deploys) and the bucket run
 * evidence goes to (docs/specs/byo-evidence-storage.md). Was three pages.
 * The storage API resolves the same active team as the page, so only that
 * team's workspaces are offered as scopes.
 */
export default async function IntegrationsSettingsPage() {
  const { user, teams, currentTeamId, workspaces, permsByTeam } = await loadSettingsContext();
  const disconnectable = await loadDisconnectableInstallationIds(user.id);
  const teamWorkspaces = workspaces
    .filter((w) => w.teamId === currentTeamId)
    .map((w) => ({ id: w.id, name: w.name }));
  return (
    <SettingsPage title="Integrations" readOnly={settingsReadOnly('integrations', permsInAnyTeam(permsByTeam))}>
      <GitHubSection disconnectableIds={disconnectable} />
      {/* A Vercel token is a team credential: manage_team_credentials in its team. */}
      <VercelSection
        teams={teams.map((t) => ({ id: t.id, name: t.name }))}
        manageableTeamIds={teamIdsHolding(permsByTeam, 'manage_team_credentials')}
      />
      <StorageSection workspaces={teamWorkspaces} />
    </SettingsPage>
  );
}
