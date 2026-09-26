import SettingsPage from '../_components/SettingsPage';
import AgentBackendsSection from '../AgentBackendsSection';
import RunnerTokensSection from '../RunnerTokensSection';
import { loadRunnerAccounts, loadSettingsContext } from '../_lib/settings-context';

export const dynamic = 'force-dynamic';

/** Settings → Connections → Runners (was /app/settings#agent-backends). */
export default async function RunnersSettingsPage() {
  const { teams, currentTeamId, workspaces } = await loadSettingsContext();
  const accounts = await loadRunnerAccounts(teams.map((t) => t.id));

  return (
    <SettingsPage
      title="Runners"
      description="Runners do the work on your own machines. They sign in to Claude or Codex with your subscription or API key, and connect to buildd with a runner token."
    >
      <AgentBackendsSection workspaces={workspaces} currentTeamId={currentTeamId} />
      <RunnerTokensSection accounts={accounts} workspaces={workspaces} />
    </SettingsPage>
  );
}
