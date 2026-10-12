import SettingsPage from '../_components/SettingsPage';
import { loadSettingsContext } from '../_lib/settings-context';
import { settingsReadOnly } from '@/lib/settings-nav';
import { defaultOffReason } from '@buildd/core/task-estimate-rollout';
import { loadTaskEstimatesState } from '@buildd/core/task-estimate-source';
import TaskEstimatesFeature from './TaskEstimatesFeature';

export const dynamic = 'force-dynamic';

/**
 * Settings › Team › Features: optional features for the active team. Owners and
 * admins (manage_team_settings) switch them; members see the state read-only.
 */
export default async function FeaturesSettingsPage() {
  const { currentTeamId, perms } = await loadSettingsContext();
  if (!currentTeamId) {
    return (
      <SettingsPage title="Features">
        <p className="text-sm text-text-muted">Not on a team.</p>
      </SettingsPage>
    );
  }
  const state = await loadTaskEstimatesState(currentTeamId);
  return (
    <SettingsPage title="Features" readOnly={settingsReadOnly('features', perms)}>
      {state.error ? (
        <p className="text-sm text-text-muted" role="alert">Couldn&apos;t load this team&apos;s features. Try again in a moment.</p>
      ) : (
        <TaskEstimatesFeature
          teamId={currentTeamId}
          initial={{ enabled: state.enabled, source: state.source, defaultOn: state.defaultOn }}
          canManage={perms.manage_team_settings}
          defaultOffReason={defaultOffReason()}
        />
      )}
    </SettingsPage>
  );
}
