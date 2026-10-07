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
import { roleHas } from '@/lib/permission-registry';
import { getTeamPermissionOverrides } from '@/lib/permissions';

export const dynamic = 'force-dynamic';

const NO_FLEET: FleetSnapshot = { runners: [], live: 0, capacity: 0, window: { from: 0, to: 0 } };

/**
 * Settings → Connections → Runners (was /app/settings#agent-backends).
 * Fleet first (what runs your tasks), then connections (what it signs in
 * with), then runner tokens (how it reaches buildd).
 */
export default async function RunnersSettingsPage() {
  const { user, teams, currentTeamId, currentTeam, workspaces } = await loadSettingsContext();
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
  // Owners/admins of a token's team may change its host-runner flag (the PUT
  // route enforces the same rule); a personal team counts as owned.
  const teamOverrides = await Promise.all(teams.map((t) => getTeamPermissionOverrides(t.id)));
  const adminTeamIds = new Set(
    teams
      .filter((t, i) => roleHas(t.role, 'manage_team_keys', teamOverrides[i]) || t.slug === `personal-${user.id}`)
      .map((t) => t.id),
  );
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
          <AgentBackendsSection workspaces={workspaces} currentTeamId={currentTeamId} />
          <CloudflareSection teams={cloudTeams} defaultTeamId={teamId} />
        </div>
      </SettingsSection>
      <RunnerTokensSection accounts={tokens} workspaces={workspaces} />
    </SettingsPage>
  );
}
