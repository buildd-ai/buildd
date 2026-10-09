import SettingsPage from '../_components/SettingsPage';
import { loadSettingsContext } from '../_lib/settings-context';
import { getChatAvailability } from '@/lib/chat-availability';
import ModelProvidersClient from './ModelProvidersClient';
import { PROVIDERS_DESCRIPTION } from './provider-copy';

export const dynamic = 'force-dynamic';

/**
 * Settings → Connections → Model providers: a core connection next to Runners.
 * Was split across /app/settings/models#provider-keys and the You page.
 */
export default async function ModelProvidersPage() {
  const { user, currentTeam, perms, workspaces } = await loadSettingsContext();
  const availability = currentTeam
    ? await getChatAvailability(user.id, currentTeam.id).catch(() => null)
    : null;

  return (
    <SettingsPage
      title="Model providers"
      description={PROVIDERS_DESCRIPTION}
    >
      {currentTeam ? (
        <ModelProvidersClient
          teamId={currentTeam.id}
          isAdmin={perms.manage_inference_providers}
          workspaces={workspaces.filter((w) => w.teamId === currentTeam.id).map((w) => ({ id: w.id, name: w.name }))}
          availability={{
            available: availability?.available === true,
            reason: availability?.available ? null : 'no_key',
          }}
        />
      ) : (
        <p className="text-sm text-text-secondary">Join or create a team to connect a model provider.</p>
      )}
    </SettingsPage>
  );
}
