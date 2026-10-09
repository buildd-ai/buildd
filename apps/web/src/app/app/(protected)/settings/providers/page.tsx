import SettingsPage from '../_components/SettingsPage';
import { loadSettingsContext } from '../_lib/settings-context';
import ModelProvidersClient from './ModelProvidersClient';
import { PROVIDERS_DESCRIPTION } from './provider-copy';

export const dynamic = 'force-dynamic';

/**
 * Settings → Connections → Providers: every model provider, at team, workspace
 * or personal scope, and the team's credential policy (ModelProvidersClient).
 */
export default async function ModelProvidersPage() {
  const { currentTeam, perms, workspaces } = await loadSettingsContext();

  return (
    <SettingsPage
      title="Providers"
      description={PROVIDERS_DESCRIPTION}
    >
      {currentTeam ? (
        <ModelProvidersClient
          teamId={currentTeam.id}
          isAdmin={perms.manage_inference_providers}
          workspaces={workspaces.filter((w) => w.teamId === currentTeam.id).map((w) => ({ id: w.id, name: w.name }))}
        />
      ) : (
        <p className="text-sm text-text-secondary">Join or create a team to connect a model provider.</p>
      )}
    </SettingsPage>
  );
}
