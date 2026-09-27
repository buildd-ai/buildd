import SettingsPage from '../_components/SettingsPage';
import { loadSettingsContext } from '../_lib/settings-context';
import { getChatAvailability } from '@/lib/chat-availability';
import ModelProvidersClient from './ModelProvidersClient';

export const dynamic = 'force-dynamic';

/**
 * Settings → Connections → Model providers: a core connection next to Runners.
 * Was split across /app/settings/models#provider-keys and the You page.
 */
export default async function ModelProvidersPage() {
  const { user, currentTeam, isTeamAdmin } = await loadSettingsContext();
  const availability = currentTeam
    ? await getChatAvailability(user.id, currentTeam.id).catch(() => null)
    : null;

  return (
    <SettingsPage
      title="Model providers"
      description="Connect OpenRouter, Anthropic or OpenAI with an API key. OpenRouter reaches every model the tiers name with one key."
    >
      {currentTeam ? (
        <ModelProvidersClient
          teamId={currentTeam.id}
          isAdmin={isTeamAdmin}
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
