import SettingsPage from '../_components/SettingsPage';
import Section from '@/components/ui/Section';
import PersonalPushoverKey from './PersonalPushoverKey';
import { loadSettingsContext } from '../_lib/settings-context';

export const dynamic = 'force-dynamic';

/**
 * Settings › You › Notifications: your own Pushover key, for alerts on work you
 * watch. Where the team's alerts go is Team › Alerts.
 */
export default async function NotificationsSettingsPage() {
  const { currentTeamId } = await loadSettingsContext();
  return (
    <SettingsPage title="Notifications" description="Alerts on work you watch, sent to your own Pushover.">
      {currentTeamId ? (
        <Section title="Channels">
          <ul className="divide-y divide-border-default" data-testid="notification-channels">
            <PersonalPushoverKey teamId={currentTeamId} />
          </ul>
        </Section>
      ) : (
        <p className="text-sm text-text-secondary">Join or create a team to get alerts.</p>
      )}
    </SettingsPage>
  );
}
