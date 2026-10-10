import SettingsPage from '../_components/SettingsPage';
import { loadSettingsContext } from '../_lib/settings-context';
import ModelProvidersClient from '../providers/ModelProvidersClient';

export const dynamic = 'force-dynamic';

/**
 * Settings › You › Keys: your own model keys, in the active team. The team's
 * and its workspaces' keys are on Team › Models; the old `?scope=mine` link to
 * Models redirects here (next.config SETTINGS_ROUTE_MOVES).
 */
export default async function KeysSettingsPage() {
  const { currentTeam, perms } = await loadSettingsContext();
  const description = 'Your own model keys. The team decides whether they pay for your work.';

  if (!currentTeam) {
    return (
      <SettingsPage title="Keys" description={description}>
        <p className="text-sm text-text-secondary">Join or create a team to add a key.</p>
      </SettingsPage>
    );
  }

  return (
    <SettingsPage title="Keys" description={description}>
      <ModelProvidersClient teamId={currentTeam.id} isAdmin={perms.manage_inference_providers} scope="mine" />
    </SettingsPage>
  );
}
