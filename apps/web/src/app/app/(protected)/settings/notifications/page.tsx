import SettingsPage from '../_components/SettingsPage';
import NotificationsSection from '../NotificationsSection';
import PersonalPushoverKey from './PersonalPushoverKey';
import { loadSettingsContext } from '../_lib/settings-context';

export const dynamic = 'force-dynamic';

/** Settings → Connections → Notifications. Yours first, then the team's channel. */
export default async function NotificationsSettingsPage() {
  const { currentTeamId, workspaces, perms } = await loadSettingsContext();
  return (
    <SettingsPage title="Notifications">
      <div className="space-y-8">
        {currentTeamId && <PersonalPushoverKey teamId={currentTeamId} />}
        <NotificationsSection workspaces={workspaces} currentTeamId={currentTeamId} canManage={perms.manage_team_notifications} />
      </div>
    </SettingsPage>
  );
}
