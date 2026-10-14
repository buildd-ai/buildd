import { consentTeamsForUser, listUserConnections } from '@/lib/mcp-grant-admin';
import SettingsPage from '../_components/SettingsPage';
import { loadSettingsContext } from '../_lib/settings-context';
import ConnectionsSection from './ConnectionsSection';
import RunnerKeysSection from './RunnerKeysSection';
import { listForeignRunners, listRunnerKeys } from '@/lib/runner-picks';

export const dynamic = 'force-dynamic';

/**
 * Settings › You › Connected apps: the person's own MCP connections to buildd
 * (lib/mcp-grant-admin.ts) and the workspaces each reaches, and their runner
 * keys with the workspaces each claims from (lib/runner-picks.ts). Personal, not
 * team-scoped: a connection can span every team the person is on, so it is
 * read for the signed-in user only.
 *
 * The team's apps and agent access live at Settings › Team › Apps
 * (../apps/page.tsx). next.config sends a link here that carries a team-app
 * query (`?connected=`, `?error=`, `?request=`, `?reconnect=`) there.
 */
export default async function ConnectionsSettingsPage() {
  const { user } = await loadSettingsContext();
  const [{ connections, legacy }, consentTeams, runnerKeys, foreignRunners] = await Promise.all([
    listUserConnections(user.id),
    consentTeamsForUser(user.id),
    listRunnerKeys(user.id),
    listForeignRunners(user.id),
  ]);
  return (
    <SettingsPage title="Connected apps" description="Apps you connected to buildd.">
      <ConnectionsSection initial={{ connections, legacy, teams: consentTeams }} />
      <RunnerKeysSection keys={runnerKeys} foreign={foreignRunners} />
    </SettingsPage>
  );
}
