import Link from 'next/link';
import SettingsPage from '../_components/SettingsPage';
import SettingsSection from '../SettingsSection';
import RunnerTokensSection from '../RunnerTokensSection';
import CloudflareSection from '../CloudflareSection';
import { StatusChip } from '../_components/ConnectionRow';
import { loadAccountLastSeen, loadRunnerAccounts, loadSettingsContext } from '../_lib/settings-context';
import { loadFleetSnapshot } from '@/lib/home-fleet';
import { teamHasAgentCredential } from '@/lib/getting-started-load';
import type { FleetSnapshot } from '@buildd/shared';
import FleetOverview from './FleetOverview';
import CloudRunnerRow from './CloudRunnerRow';
import SignInsAnchorRedirect from './SignInsAnchorRedirect';
import { permsInAnyTeam, teamIdsHolding } from '../_lib/settings-permissions';
import { settingsReadOnly } from '@/lib/settings-nav';

export const dynamic = 'force-dynamic';

const NO_FLEET: FleetSnapshot = { runners: [], live: 0, capacity: 0, window: { from: 0, to: 0 } };

/** Where runner sign-ins (Claude, Codex, an OpenAI key, provider routing) live. */
const SIGN_INS_HREF = '/app/settings/models#sign-ins';

/**
 * Settings → Runners. Fleet first (what runs your tasks), then connections
 * (the Cloudflare account cloud runs use, and a pointer to the sign-ins on
 * Models), then runner tokens (how a runner reaches buildd).
 */
export default async function RunnersSettingsPage() {
  const { user, teams, currentTeamId, currentTeam, workspaces, permsByTeam } = await loadSettingsContext();
  const teamId = currentTeamId ?? teams[0]?.id ?? null;
  const teamWsIds = workspaces.filter((w) => w.teamId === teamId).map((w) => w.id);
  const [accounts, fleet, hasSignIn] = await Promise.all([
    loadRunnerAccounts(teams.map((t) => t.id)),
    loadFleetSnapshot({ teamId, wsIds: teamWsIds, now: Date.now() }).catch((err) => {
      console.error('[settings/runners] fleet load failed (non-fatal):', err);
      return NO_FLEET;
    }),
    // Status only: null (unknown) drops the chip rather than guessing.
    teamId ? teamHasAgentCredential(teamId).catch(() => null) : Promise.resolve(null),
  ]);
  const lastSeen = await loadAccountLastSeen(accounts.map((a) => a.id as string)).catch(() => ({} as Record<string, string>));
  // Each control follows the permission its route enforces, with each team's
  // overrides (a personal team counts as owned): the host-runner flag is
  // manage_team_keys, the Cloudflare token manage_team_model_keys.
  const adminTeamIds = new Set(teamIdsHolding(permsByTeam, 'manage_team_keys'));
  const cloudflareTeamIds = teamIdsHolding(permsByTeam, 'manage_team_model_keys');
  // Who minted a key stays on the server: the client gets only what it may do.
  const tokens = accounts.map(({ createdByUserId, ...a }) => ({
    ...a,
    lastSeenAt: lastSeen[a.id] ?? null,
    canManageHostRunner: adminTeamIds.has(a.teamId),
    // DELETE /api/accounts/[id]: your own key, or manage_team_keys in its team.
    canDelete: adminTeamIds.has(a.teamId) || (createdByUserId != null && createdByUserId === user.id),
  }));
  const cloudTeams = teams.map((t) => ({ id: t.id, name: t.name }));

  return (
    <SettingsPage title="Runners" readOnly={settingsReadOnly('runners', permsInAnyTeam(permsByTeam))}>
      <SignInsAnchorRedirect />
      <FleetOverview
        fleet={fleet}
        teamName={teams.length > 1 ? (currentTeam?.name ?? null) : null}
        cloud={teamId ? <CloudRunnerRow teamId={teamId} canManage={cloudflareTeamIds.includes(teamId)} /> : undefined}
      />
      <SettingsSection title="Connections" bare>
        <div data-testid="runners-connections" className="border-y border-border-default divide-y divide-border-default">
          <div data-testid="runners-sign-ins" className="flex min-h-14 items-center gap-3 py-2.5 pl-4 pr-3">
            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                <span className="text-sm font-semibold text-text-primary">Sign-ins</span>
                {hasSignIn === true && <StatusChip tone="ok">Connected</StatusChip>}
                {hasSignIn === false && <StatusChip tone="idle">Not connected</StatusChip>}
              </span>
              <span className="mt-1 block truncate text-meta text-text-muted">What your runners log in with</span>
            </span>
            <Link href={SIGN_INS_HREF} className="btn btn-quiet shrink-0">Models ›</Link>
          </div>
          <CloudflareSection teams={cloudTeams} defaultTeamId={teamId} manageableTeamIds={cloudflareTeamIds} />
        </div>
      </SettingsSection>
      <RunnerTokensSection accounts={tokens} workspaces={workspaces} />
    </SettingsPage>
  );
}
