import { db } from '@buildd/core/db';
import { accounts, skills, workspaces } from '@buildd/core/db/schema';
import { desc, inArray } from 'drizzle-orm';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth-helpers';
import { getUserWorkspaceIds, getUserTeamsWithDetails, type UserTeam } from '@/lib/team-access';
import GitHubSection from './GitHubSection';
import ApiKeysSection from './ApiKeysSection';
import SkillsSection from './SkillsSection';

export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  const user = await getCurrentUser();

  if (!user) {
    redirect('/app/auth/signin');
  }

  let allAccounts: any[] = [];
  let userTeams: UserTeam[] = [];
  let teamsError = false;
  let teamSkills: any[] = [];
  let userWorkspaces: { id: string; name: string }[] = [];

  // Fetch teams - uses React cache() so shared with layout
  try {
    userTeams = await getUserTeamsWithDetails(user.id);
  } catch (error) {
    console.error('Settings: teams query error:', error);
    teamsError = true;
  }

  const teamIds = userTeams.map(t => t.id);

  // Fetch accounts
  try {
    if (teamIds.length > 0) {
      allAccounts = await db.query.accounts.findMany({
        where: inArray(accounts.teamId, teamIds),
        orderBy: desc(accounts.createdAt),
        with: {
          team: { columns: { name: true } },
        },
      });
    }
  } catch (error) {
    console.error('Settings: accounts query error:', error);
  }

  // Fetch team-level skills
  try {
    if (teamIds.length > 0) {
      teamSkills = await db.query.skills.findMany({
        where: inArray(skills.teamId, teamIds),
        orderBy: (s, { asc }) => [asc(s.slug)],
      });
    }

    // Fetch workspaces for skill management link
    const wsIds = await getUserWorkspaceIds(user.id);
    if (wsIds.length > 0) {
      userWorkspaces = await db.query.workspaces.findMany({
        where: inArray(workspaces.id, wsIds),
        columns: { id: true, name: true },
        limit: 1,
      });
    }
  } catch (error) {
    console.error('Settings: skills query error:', error);
  }

  const roleColors: Record<string, string> = {
    owner: 'bg-primary/10 text-primary',
    admin: 'bg-status-info/10 text-status-info',
    member: 'bg-surface-3 text-text-primary',
  };

  return (
    <main className="min-h-screen p-4 md:p-8">
      <div className="max-w-2xl mx-auto">
        <Link href="/app/dashboard" className="text-sm text-text-secondary hover:text-text-primary mb-2 block">
          &larr; Dashboard
        </Link>
        <h1 className="text-2xl font-bold mb-8">Settings</h1>

        <div className="space-y-10">
          {/* GitHub */}
          <GitHubSection />

          <hr className="border-border-default" />

          {/* API Keys */}
          <ApiKeysSection accounts={allAccounts} />

          <hr className="border-border-default" />

          {/* Teams */}
          <section>
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-lg font-semibold">Teams</h2>
              <Link
                href="/app/teams/new"
                className="px-3 py-1.5 text-sm bg-primary text-white rounded-md hover:bg-primary-hover"
              >
                + New Team
              </Link>
            </div>

            {teamsError ? (
              <div className="border border-dashed border-status-error/30 rounded-lg p-6 text-center">
                <p className="text-text-secondary mb-3 text-sm">Failed to load teams</p>
                <Link
                  href="/app/settings"
                  className="text-sm text-primary hover:underline"
                >
                  Retry
                </Link>
              </div>
            ) : userTeams.length === 0 ? (
              <div className="border border-dashed border-border-default rounded-lg p-6 text-center">
                <p className="text-text-secondary mb-3 text-sm">No teams yet</p>
                <Link
                  href="/app/teams/new"
                  className="text-sm text-primary hover:underline"
                >
                  Create a team
                </Link>
              </div>
            ) : (
              <div className="border border-border-default rounded-lg divide-y divide-border-default">
                {userTeams.map((team) => {
                  const isPersonal = team.slug.startsWith('personal-');
                  return (
                    <Link
                      key={team.id}
                      href={`/app/teams/${team.id}`}
                      className="block p-4 hover:bg-surface-3"
                    >
                      <div className="flex justify-between items-center">
                        <div className="flex items-center gap-2 min-w-0">
                          <h3 className="font-medium truncate">{team.name}</h3>
                          {isPersonal && (
                            <span className="px-1.5 py-0.5 text-xs bg-surface-3 text-text-secondary rounded flex-shrink-0">
                              Personal
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-3 text-sm flex-shrink-0">
                          <span className="text-text-secondary">
                            {team.memberCount} {team.memberCount === 1 ? 'member' : 'members'}
                          </span>
                          <span className={`inline-block px-2 py-0.5 text-xs rounded-full ${roleColors[team.role] || roleColors.member}`}>
                            {team.role}
                          </span>
                        </div>
                      </div>
                    </Link>
                  );
                })}
              </div>
            )}
          </section>

          <hr className="border-border-default" />

          {/* Skills */}
          <SkillsSection skills={teamSkills} workspaces={userWorkspaces} />
        </div>
      </div>
    </main>
  );
}
