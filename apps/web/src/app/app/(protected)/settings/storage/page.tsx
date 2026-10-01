import SettingsPage from '../_components/SettingsPage';
import { loadSettingsContext } from '../_lib/settings-context';
import StorageSection from './StorageSection';

export const dynamic = 'force-dynamic';

/**
 * Settings → Connections → Storage: the bucket a team's run evidence goes to
 * (docs/specs/byo-evidence-storage.md, "Backend configuration"). The API
 * resolves the same active team as the page, so only that team's workspaces
 * are offered as scopes.
 */
export default async function StorageSettingsPage() {
  const { currentTeamId, workspaces } = await loadSettingsContext();
  const teamWorkspaces = workspaces
    .filter((w) => w.teamId === currentTeamId)
    .map((w) => ({ id: w.id, name: w.name }));
  return (
    <SettingsPage
      title="Storage"
      description="Where run evidence is kept: failing command output, test reports, CI logs and transcripts. Use your own S3, R2 or S3-compatible bucket, for the whole team or for one workspace."
    >
      <StorageSection workspaces={teamWorkspaces} />
    </SettingsPage>
  );
}
