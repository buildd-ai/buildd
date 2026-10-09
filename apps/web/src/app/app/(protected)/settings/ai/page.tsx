import { hasTeamInferenceKey } from '@buildd/core/inference-keys';
import SettingsPage from '../_components/SettingsPage';
import ModelFeatures from './ModelFeatures';
// Experiment: remove with apps/web/src/lib/chat-retro/ (see its REMOVAL.md).
import ChatRetroSection from '@/lib/chat-retro/ChatRetroSection';
import { loadSettingsContext } from '../_lib/settings-context';

export const dynamic = 'force-dynamic';

/** Settings → AI → AI features (was /app/settings#inference-spending). */
export default async function AiSettingsPage() {
  const { currentTeam, perms } = await loadSettingsContext();
  const hasTeamKey = currentTeam ? await hasTeamInferenceKey(currentTeam.id).catch(() => false) : false;

  return (
    <SettingsPage title="AI features">
      {currentTeam ? (
        <>
          <ModelFeatures teamId={currentTeam.id} canManage={perms.manage_team_settings} hasTeamKey={hasTeamKey} />
          <ChatRetroSection teamId={currentTeam.id} isAdmin={perms.manage_chat_retro} />
        </>
      ) : (
        <p className="text-sm text-text-secondary">Join or create a team first.</p>
      )}
    </SettingsPage>
  );
}
