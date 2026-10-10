import Link from 'next/link';
import { db } from '@buildd/core/db';
import { teams, teamMembers } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import SettingsPage from '../_components/SettingsPage';
import TimezoneSection from '../TimezoneSection';
import TeamPermissionsSection from './TeamPermissionsSection';
import TeamDetailClient from './TeamDetailClient';
import { loadSettingsContext } from '../_lib/settings-context';
import { roleHas } from '@/lib/permission-registry';
import PrimaryAction from '@/components/ui/PrimaryAction';
import { resolveTeamQaState, withQaFixtureMembers } from './qa-state';
import { pickShownTeam } from './shown-team';
import { getTeamPermissionOverrides } from '@/lib/permissions';

export const dynamic = 'force-dynamic';

/**
 * Settings → Team: a team's people, its timezone, and who can do what (team
 * permission overrides). Shows the active team, or `?team=<id>` when the
 * person is a member of it, so a link to another team (the old
 * /app/teams/[id]) lands on that team's members.
 * `?state=multi-member` (dev server only) adds a synthetic member row — see ./qa-state.ts.
 */
export default async function TeamSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ state?: string | string[]; team?: string | string[] }>;
}) {
  const params = await searchParams;
  const qaState = resolveTeamQaState(params.state);
  const { user, teams: userTeams, currentTeam } = await loadSettingsContext();
  const shown = pickShownTeam(userTeams, params.team, currentTeam);

  if (!shown) {
    return (
      <SettingsPage title="Team">
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-sm text-text-muted">Not on a team.</p>
          <PrimaryAction href="/app/settings/team/new">Create a team</PrimaryAction>
        </div>
      </SettingsPage>
    );
  }

  const [team, members] = await Promise.all([
    db.query.teams.findFirst({
      where: eq(teams.id, shown.id),
      columns: { id: true, name: true, slug: true, createdAt: true },
    }).catch(() => null),
    db.query.teamMembers.findMany({
      where: eq(teamMembers.teamId, shown.id),
      with: { user: true },
    }).catch(() => []),
  ]);

  const role = shown.role as 'owner' | 'admin' | 'member';
  const permissionOverrides = team ? await getTeamPermissionOverrides(team.id) : null;
  const otherTeams = userTeams.filter((t) => t.id !== shown.id);

  const sections = (
    <>
      <TimezoneSection
        teams={userTeams.map((t) => ({ id: t.id, name: t.name }))}
        currentTeamId={shown.id}
      />

      {/* A personal team has one member, its owner: there is nothing to grant. */}
      {team && !team.slug.startsWith('personal-') && <TeamPermissionsSection teamId={team.id} />}
    </>
  );

  return (
    <SettingsPage title="Team">
      {otherTeams.length > 0 && (
        <details data-testid="team-switcher" className="group text-sm">
          <summary className="flex min-h-11 md:min-h-0 cursor-pointer list-none items-center gap-1.5 text-text-secondary">
            <span className="text-text-muted">Team:</span>
            <span className="font-medium text-text-primary">{shown.name}</span>
            <span aria-hidden="true">·</span>
            <span className="underline underline-offset-2 hover:text-text-primary">Switch</span>
          </summary>
          <div className="mt-2 divide-y divide-border-default border-y border-border-default">
            {otherTeams.map((t) => (
              <Link
                key={t.id}
                href={`/app/settings/team?team=${encodeURIComponent(t.id)}`}
                className="flex min-h-11 items-center justify-between gap-3 py-2 hover:bg-surface-3 transition-colors"
              >
                <span className="truncate font-medium text-text-primary">{t.name}</span>
                <span className="shrink-0 text-text-muted">{t.role}</span>
              </Link>
            ))}
          </div>
        </details>
      )}

      {team ? (
        <TeamDetailClient
          // Remount on a team switch: the rename draft and invite form belong to one team.
          key={team.id}
          team={{ id: team.id, name: team.name, slug: team.slug, createdAt: team.createdAt.toISOString() }}
          members={withQaFixtureMembers(members.map((m) => ({
            userId: m.userId,
            role: m.role as 'owner' | 'admin' | 'member',
            joinedAt: m.joinedAt.toISOString(),
            name: m.user.name,
            email: m.user.email,
            image: m.user.image,
          })), qaState)}
          currentUserRole={role}
          currentUserId={user.id}
          isPersonal={team.slug.startsWith('personal-')}
          canManage={roleHas(role, 'manage_team_members', permissionOverrides)}
          permissionOverrides={permissionOverrides}
        >
          {sections}
        </TeamDetailClient>
      ) : (
        <>
          <p className="text-sm text-text-muted">Could not load the team.</p>
          {sections}
        </>
      )}
    </SettingsPage>
  );
}
