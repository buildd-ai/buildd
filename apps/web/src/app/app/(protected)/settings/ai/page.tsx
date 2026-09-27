import { hasTeamInferenceKey } from '@buildd/core/inference-keys';
import SettingsPage from '../_components/SettingsPage';
import ModelFeatures from './ModelFeatures';
import { loadSettingsContext } from '../_lib/settings-context';

export const dynamic = 'force-dynamic';

/** Settings → AI → AI features (was /app/settings#inference-spending). */
export default async function AiSettingsPage() {
  const { currentTeam, isTeamAdmin } = await loadSettingsContext();
  const hasTeamKey = currentTeam ? await hasTeamInferenceKey(currentTeam.id).catch(() => false) : false;

  return (
    <SettingsPage title="AI features">
      {currentTeam ? (
        <ModelFeatures teamId={currentTeam.id} canManage={isTeamAdmin} hasTeamKey={hasTeamKey} />
      ) : (
        <p className="text-sm text-text-secondary">Join or create a team first.</p>
      )}
    </SettingsPage>
  );
}
