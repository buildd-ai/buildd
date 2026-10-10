import SettingsPage from '../_components/SettingsPage';
import NotificationsSection from '../NotificationsSection';
import { loadSettingsContext } from '../_lib/settings-context';
import { settingsReadOnly } from '@/lib/settings-nav';

export const dynamic = 'force-dynamic';

/**
 * Settings › Team › Alerts: the team's channels (Pushover app, webhook) and
 * which events reach them. Your own Pushover key is You › Notifications. The
 * route says notifications so it sits with that module (scripts/module-boundaries.ts).
 */
export default async function AlertsSettingsPage() {
  const { currentTeamId, workspaces, perms } = await loadSettingsContext();
  return (
    <SettingsPage title="Alerts" readOnly={settingsReadOnly('alerts', perms)}>
      <NotificationsSection
        workspaces={workspaces}
        currentTeamId={currentTeamId}
        canManage={perms.manage_team_notifications}
      />
    </SettingsPage>
  );
}
