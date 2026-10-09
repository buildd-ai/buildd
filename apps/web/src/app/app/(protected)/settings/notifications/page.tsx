import SettingsPage from '../_components/SettingsPage';
import NotificationsSection from '../NotificationsSection';
import PersonalPushoverKey from './PersonalPushoverKey';
import { loadSettingsContext } from '../_lib/settings-context';

export const dynamic = 'force-dynamic';

/**
 * Settings › Integrations › Notifications. One Channels list (the team's
 * Pushover, yours, the team's webhook), then which events the team's channels get.
 */
export default async function NotificationsSettingsPage() {
  const { currentTeamId, workspaces, perms } = await loadSettingsContext();
  return (
    <SettingsPage title="Notifications">
      <NotificationsSection
        workspaces={workspaces}
        currentTeamId={currentTeamId}
        canManage={perms.manage_team_notifications}
        personal={currentTeamId ? <PersonalPushoverKey teamId={currentTeamId} /> : undefined}
      />
    </SettingsPage>
  );
}
