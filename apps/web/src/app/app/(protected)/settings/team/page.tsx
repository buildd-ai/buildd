import Link from 'next/link';
import { db } from '@buildd/core/db';
import { teams, teamMembers } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import SettingsPage from '../_components/SettingsPage';
import TimezoneSection from '../TimezoneSection';
import TeamDetailClient from '../../teams/[id]/TeamDetailClient';
import { loadSettingsContext } from '../_lib/settings-context';
import { roleHas } from '@/lib/permission-registry';
import { resolveTeamQaState, withQaFixtureMembers } from './qa-state';
import { getTeamPermissionOverrides } from '@/lib/permissions';

export const dynamic = 'force-dynamic';

/**
 * Settings → Team → Members: the active team's people, plus the team timezone.
 * Other teams stay reachable from Profile → Your teams (/app/teams/[id]).
 * `?state=multi-member` (dev server only) adds a synthetic member row — see ./qa-state.ts.
 */
export default async function TeamSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ state?: string | string[] }>;
}) {
  const qaState = resolveTeamQaState((await searchParams).state);
  const { user, teams: userTeams, currentTeam } = await loadSettingsContext();

  if (!currentTeam) {
    return (
      <SettingsPage title="Members">
        <div className="card p-6 text-center">
          <p className="text-sm text-text-secondary mb-3">Not on a team.</p>
          <Link href="/app/teams/new" className="btn btn-primary">Create a team</Link>
        </div>
      </SettingsPage>
    );
  }

  const [team, members] = await Promise.all([
    db.query.teams.findFirst({
      where: eq(teams.id, currentTeam.id),
      columns: { id: true, name: true, slug: true, createdAt: true },
    }).catch(() => null),
    db.query.teamMembers.findMany({
      where: eq(teamMembers.teamId, currentTeam.id),
      with: { user: true },
    }).catch(() => []),
  ]);

  const role = currentTeam.role as 'owner' | 'admin' | 'member';

  return (
    <SettingsPage
      title="Members"
      description={<><Link href="/app/team" className="underline hover:text-text-primary">Agent roles</Link> are on the Team page.</>}
    >
      {team ? (
        <TeamDetailClient
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
          canManage={roleHas(role, 'manage_team_members', await getTeamPermissionOverrides(team.id))}
        />
      ) : (
        <p className="text-sm text-text-secondary">Could not load the team.</p>
      )}

      <TimezoneSection
        teams={userTeams.map((t) => ({ id: t.id, name: t.name }))}
        currentTeamId={currentTeam.id}
      />
    </SettingsPage>
  );
}
