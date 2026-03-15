import { db } from '@buildd/core/db';
import { accounts, workspaces } from '@buildd/core/db/schema';
import { desc, inArray } from 'drizzle-orm';
import { cookies } from 'next/headers';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth-helpers';
import { getUserWorkspaceIds, getUserTeamsWithDetails, type UserTeam } from '@/lib/team-access';
import { TeamSwitcher } from '@/components/TeamSwitcher';
import GitHubSection from './GitHubSection';
import ApiKeysSection from './ApiKeysSection';

export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  const user = await getCurrentUser();

  if (!user) {
    redirect('/app/auth/signin');
  }

  let allAccounts: any[] = [];
  let userTeams: UserTeam[] = [];
  let teamsError = false;
  let userWorkspaces: { id: string; name: string; repo: string | null }[] = [];

  try {
    userTeams = await getUserTeamsWithDetails(user.id);
  } catch (error) {
    console.error('Settings: teams query error:', error);
    teamsError = true;
  }

  const teamIds = userTeams.map(t => t.id);

  const cookieStore = await cookies();
  const teamCookie = cookieStore.get('buildd-team')?.value;
  const currentTeamId = (teamCookie && userTeams.some(t => t.id === teamCookie))
    ? teamCookie
    : userTeams[0]?.id || null;

  try {
    if (teamIds.length > 0) {
      allAccounts = await db.query.accounts.findMany({
        where: inArray(accounts.teamId, teamIds),
        orderBy: desc(accounts.createdAt),
        with: {
          team: { columns: { name: true } },
          accountWorkspaces: { columns: { workspaceId: true } },
        },
      });
    }
  } catch (error) {
    console.error('Settings: accounts query error:', error);
  }

  try {
    const wsIds = await getUserWorkspaceIds(user.id);
    if (wsIds.length > 0) {
      userWorkspaces = await db.query.workspaces.findMany({
        where: inArray(workspaces.id, wsIds),
        columns: { id: true, name: true, repo: true },
      });
    }
  } catch (error) {
    console.error('Settings: workspaces query error:', error);
  }

  const roleColors: Record<string, string> = {
    owner: 'bg-primary/10 text-primary',
    admin: 'bg-status-info/10 text-status-info',
    member: 'bg-surface-3 text-text-primary',
  };

  return (
    <main className="min-h-screen pt-14 px-4 pb-24 md:p-8 md:pb-8">
      <div className="max-w-2xl mx-auto space-y-12">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        </div>

        {/* Team Switcher (mobile only) */}
        {userTeams.length > 1 && (
          <section className="md:hidden">
            <h2 className="section-label mb-3">Switch Team</h2>
            <div className="card p-3">
              <TeamSwitcher teams={userTeams} currentTeamId={currentTeamId} />
            </div>
          </section>
        )}

        {/* GitHub */}
        <GitHubSection />

        {/* API Keys — compact view */}
        <ApiKeysSection
          accounts={allAccounts.map(a => ({ ...a, hasOauthToken: !!a.oauthToken }))}
          workspaces={userWorkspaces}
        />

        {/* Teams */}
        <section>
          <div className="flex justify-between items-center mb-4">
            <h2 className="section-label">Teams</h2>
            <Link
              href="/app/teams/new"
              className="text-sm text-text-secondary hover:text-text-primary transition-colors"
            >
              + New Team
            </Link>
          </div>

          {teamsError ? (
            <div className="card p-6 text-center">
              <p className="text-text-muted text-sm mb-3">Failed to load teams</p>
              <Link href="/app/settings" className="text-sm text-primary hover:underline">
                Retry
              </Link>
            </div>
          ) : userTeams.length === 0 ? (
            <div className="card p-6 text-center">
              <p className="text-text-muted text-sm mb-3">No teams yet</p>
              <Link href="/app/teams/new" className="text-sm text-primary hover:underline">
                Create a team
              </Link>
            </div>
          ) : (
            <div className="card divide-y divide-border-default">
              {userTeams.map((team) => {
                const isPersonal = team.slug.startsWith('personal-');
                return (
                  <Link
                    key={team.id}
                    href={`/app/teams/${team.id}`}
                    className="block p-4 hover:bg-surface-3/50 transition-colors first:rounded-t-[10px] last:rounded-b-[10px]"
                  >
                    <div className="flex justify-between items-center">
                      <div className="flex items-center gap-2 min-w-0">
                        <h3 className="font-medium truncate">{team.name}</h3>
                        {isPersonal && (
                          <span className="px-1.5 py-0.5 text-xs bg-surface-3 text-text-muted rounded flex-shrink-0">
                            Personal
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-3 text-sm flex-shrink-0">
                        <span className="text-text-muted">
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

        {/* Workspaces — links to per-workspace settings */}
        {userWorkspaces.length > 0 && (
          <section>
            <h2 className="section-label mb-4">Workspaces</h2>
            <div className="card divide-y divide-border-default">
              {userWorkspaces.map((ws) => (
                <Link
                  key={ws.id}
                  href={`/app/workspaces/${ws.id}/skills`}
                  className="flex items-center justify-between p-4 hover:bg-surface-3/50 transition-colors first:rounded-t-[10px] last:rounded-b-[10px]"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">{ws.name}</p>
                    {ws.repo && <p className="text-xs text-text-muted truncate">{ws.repo}</p>}
                  </div>
                  <span className="text-xs text-text-muted flex-shrink-0">Skills, Slack, Discord</span>
                </Link>
              ))}
            </div>
          </section>
        )}
      </div>
    </main>
  );
}
