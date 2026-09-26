import SettingsPage from '../_components/SettingsPage';
import NotificationsSection from '../NotificationsSection';
import { loadSettingsContext } from '../_lib/settings-context';

export const dynamic = 'force-dynamic';

/** Settings → Connections → Notifications. */
export default async function NotificationsSettingsPage() {
  const { currentTeamId, workspaces } = await loadSettingsContext();
  return (
    <SettingsPage title="Notifications">
      <NotificationsSection workspaces={workspaces} currentTeamId={currentTeamId} />
    </SettingsPage>
  );
}
