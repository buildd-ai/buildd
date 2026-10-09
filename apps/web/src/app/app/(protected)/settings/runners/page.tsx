import SettingsPage from '../_components/SettingsPage';
import SettingsSection from '../SettingsSection';
import AgentBackendsSection from '../AgentBackendsSection';
import RunnerTokensSection from '../RunnerTokensSection';
import CloudflareSection from '../CloudflareSection';
import { loadAccountLastSeen, loadRunnerAccounts, loadSettingsContext } from '../_lib/settings-context';
import { loadFleetSnapshot } from '@/lib/home-fleet';
import type { FleetSnapshot } from '@buildd/shared';
import FleetOverview from './FleetOverview';
import CloudRunnerRow from './CloudRunnerRow';
import { teamIdsHolding } from '../_lib/settings-permissions';

export const dynamic = 'force-dynamic';

const NO_FLEET: FleetSnapshot = { runners: [], live: 0, capacity: 0, window: { from: 0, to: 0 } };

/**
 * Settings → Connections → Runners (was /app/settings#agent-backends).
 * Fleet first (what runs your tasks), then connections (what it signs in
 * with), then runner tokens (how it reaches buildd).
 */
export default async function RunnersSettingsPage() {
  const { teams, currentTeamId, currentTeam, workspaces, perms, permsByTeam } = await loadSettingsContext();
  const teamId = currentTeamId ?? teams[0]?.id ?? null;
  const teamWsIds = workspaces.filter((w) => w.teamId === teamId).map((w) => w.id);
  const [accounts, fleet] = await Promise.all([
    loadRunnerAccounts(teams.map((t) => t.id)),
    loadFleetSnapshot({ teamId, wsIds: teamWsIds, now: Date.now() }).catch((err) => {
      console.error('[settings/runners] fleet load failed (non-fatal):', err);
      return NO_FLEET;
    }),
  ]);
  const lastSeen = await loadAccountLastSeen(accounts.map((a) => a.id as string)).catch(() => ({} as Record<string, string>));
  // Each control follows the permission its route enforces, with each team's
  // overrides (a personal team counts as owned): the host-runner flag is
  // manage_team_keys, credentials manage_team_credentials, the Cloudflare
  // token manage_team_model_keys, provider routing manage_team_settings.
  const adminTeamIds = new Set(teamIdsHolding(permsByTeam, 'manage_team_keys'));
  const credentialTeamIds = teamIdsHolding(permsByTeam, 'manage_team_credentials');
  const cloudflareTeamIds = teamIdsHolding(permsByTeam, 'manage_team_model_keys');
  const tokens = accounts.map((a) => ({
    ...a,
    lastSeenAt: lastSeen[a.id] ?? null,
    canManageHostRunner: adminTeamIds.has(a.teamId),
  }));
  const cloudTeams = teams.map((t) => ({ id: t.id, name: t.name }));

  return (
    <SettingsPage
      title="Runners"
    >
      <FleetOverview
        fleet={fleet}
        teamName={teams.length > 1 ? (currentTeam?.name ?? null) : null}
        cloud={teamId ? <CloudRunnerRow teamId={teamId} /> : undefined}
      />
      <SettingsSection title="Connections" id="agent-backends" bare>
        <div data-testid="runners-connections" className="card divide-y divide-border-default p-0">
          <AgentBackendsSection
            workspaces={workspaces}
            currentTeamId={currentTeamId}
            manageableTeamIds={credentialTeamIds}
            canManage={perms.manage_team_credentials}
            canManageRouting={perms.manage_team_settings}
          />
          <CloudflareSection teams={cloudTeams} defaultTeamId={teamId} manageableTeamIds={cloudflareTeamIds} />
        </div>
      </SettingsSection>
      <RunnerTokensSection accounts={tokens} workspaces={workspaces} />
    </SettingsPage>
  );
}
