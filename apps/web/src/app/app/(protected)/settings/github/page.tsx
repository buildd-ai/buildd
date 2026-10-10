import SettingsPage from '../_components/SettingsPage';
import GitHubSection from '../GitHubSection';
import VercelSection from '../VercelSection';
import { loadSettingsContext } from '../_lib/settings-context';
import { permsInAnyTeam, teamIdsHolding } from '../_lib/settings-permissions';
import { settingsReadOnly } from '@/lib/settings-nav';
import { loadDisconnectableInstallationIds } from './_lib/disconnectable';

export const dynamic = 'force-dynamic';

/** Settings › Team › GitHub and Vercel. */
export default async function GitHubSettingsPage() {
  const { user, teams, permsByTeam } = await loadSettingsContext();
  const disconnectable = await loadDisconnectableInstallationIds(user.id);
  return (
    <SettingsPage title="GitHub and Vercel" readOnly={settingsReadOnly('github', permsInAnyTeam(permsByTeam))}>
      <GitHubSection disconnectableIds={disconnectable} />
      {/* A Vercel token is a team credential: manage_team_credentials in its team. */}
      <VercelSection
        teams={teams.map((t) => ({ id: t.id, name: t.name }))}
        manageableTeamIds={teamIdsHolding(permsByTeam, 'manage_team_credentials')}
      />
    </SettingsPage>
  );
}
