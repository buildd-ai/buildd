import SettingsPage from '../_components/SettingsPage';
import { loadSettingsContext } from '../_lib/settings-context';
import { settingsReadOnly } from '@/lib/settings-nav';
import StorageSection from './StorageSection';

export const dynamic = 'force-dynamic';

/**
 * Settings › Team › Storage: the bucket a team's run evidence goes to
 * (docs/specs/byo-evidence-storage.md, "Backend configuration"). The API
 * resolves the same active team as the page, so only that team's workspaces
 * are offered as scopes.
 */
export default async function StorageSettingsPage() {
  const { currentTeamId, workspaces, perms } = await loadSettingsContext();
  const teamWorkspaces = workspaces
    .filter((w) => w.teamId === currentTeamId)
    .map((w) => ({ id: w.id, name: w.name }));
  return (
    <SettingsPage
      title="Storage"
      description="Command output, test reports, CI logs and transcripts from agents."
      readOnly={settingsReadOnly('storage', perms)}
    >
      <StorageSection workspaces={teamWorkspaces} />
    </SettingsPage>
  );
}
