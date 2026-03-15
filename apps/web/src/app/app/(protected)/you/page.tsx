import { db } from '@buildd/core/db';
import { accounts, workspaces, workerHeartbeats, teamMembers } from '@buildd/core/db/schema';
import { eq, inArray, desc } from 'drizzle-orm';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth-helpers';
import { getUserTeamsWithDetails, getUserWorkspaceIds, type UserTeam } from '@/lib/team-access';
import { TeamSwitcher } from '@/components/TeamSwitcher';
import SignOutButton from './SignOutButton';
import Link from 'next/link';
import GitHubSection from '../settings/GitHubSection';
import ApiKeysSection from '../settings/ApiKeysSection';

export const dynamic = 'force-dynamic';

function timeAgo(date: Date): string {
  const diff = Date.now() - date.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

export default async function YouPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/app/auth/signin');

  // Fetch teams and workspace IDs in parallel
  const [userTeams, wsIds] = await Promise.all([
    getUserTeamsWithDetails(user.id).catch(() => [] as UserTeam[]),
    getUserWorkspaceIds(user.id).catch(() => [] as string[]),
  ]);

  const teamIds = userTeams.map(t => t.id);

  const cookieStore = await cookies();
  const teamCookie = cookieStore.get('buildd-team')?.value;
  const currentTeamId = (teamCookie && userTeams.some(t => t.id === teamCookie))
    ? teamCookie
    : userTeams[0]?.id || null;

  // Parallel data fetches
  const [teamMembersList, allAccounts, heartbeats, userWorkspaces] = await Promise.all([
    // Team members for first team
    teamIds.length > 0
      ? db.query.teamMembers.findMany({
          where: eq(teamMembers.teamId, teamIds[0]),
          with: { user: { columns: { id: true, name: true, email: true, image: true } } },
        }).catch(() => [])
      : Promise.resolve([]),

    // Full account details (for ApiKeysSection)
    teamIds.length > 0
      ? db.query.accounts.findMany({
          where: inArray(accounts.teamId, teamIds),
          orderBy: desc(accounts.createdAt),
          with: {
            team: { columns: { name: true } },
            accountWorkspaces: { columns: { workspaceId: true } },
          },
        }).catch(() => [])
      : Promise.resolve([]),

    // Runner heartbeats
    teamIds.length > 0
      ? db.query.accounts.findMany({
          where: inArray(accounts.teamId, teamIds),
          columns: { id: true },
        }).then(async (accs) => {
          if (accs.length === 0) return [];
          return db.query.workerHeartbeats.findMany({
            where: inArray(workerHeartbeats.accountId, accs.map(a => a.id)),
            orderBy: desc(workerHeartbeats.lastHeartbeatAt),
            with: { account: { columns: { name: true } } },
          });
        }).catch(() => [])
      : Promise.resolve([]),

    // Workspaces
    wsIds.length > 0
      ? db.query.workspaces.findMany({
          where: inArray(workspaces.id, wsIds),
          columns: { id: true, name: true, repo: true, githubInstallationId: true },
        }).catch(() => [])
      : Promise.resolve([]),
  ]);

  const roleColors: Record<string, string> = {
    owner: 'bg-primary/10 text-primary',
    admin: 'bg-status-info/10 text-status-info',
    member: 'bg-surface-3 text-text-primary',
  };

  const initials = user.name
    ? user.name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2)
    : user.email[0].toUpperCase();

  const currentTeam = userTeams[0];

  return (
    <main className="min-h-screen pt-14 px-4 pb-24 md:p-8 md:pb-8">
      <div className="max-w-2xl mx-auto space-y-8">

        {/* Profile Section */}
        <section>
          <h2 className="section-label mb-4">Profile</h2>
          <div className="card p-5">
            <div className="flex items-center gap-4">
              {user.image ? (
                <img
                  src={user.image}
                  alt={user.name || 'Avatar'}
                  className="w-12 h-12 rounded-full object-cover"
                />
              ) : (
                <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center">
                  <span className="text-sm font-medium text-primary">{initials}</span>
                </div>
              )}
              <div className="flex-1 min-w-0">
                <p className="text-[15px] font-medium text-text-primary truncate">{user.name || 'Unnamed'}</p>
                <p className="text-xs text-text-secondary truncate">{user.email}</p>
              </div>
              <SignOutButton />
            </div>
          </div>
        </section>

        {/* Team Switcher (mobile only) */}
        {userTeams.length > 1 && (
          <section className="md:hidden">
            <h2 className="section-label mb-3">Switch Team</h2>
            <div className="card p-3">
              <TeamSwitcher teams={userTeams} currentTeamId={currentTeamId} />
            </div>
          </section>
        )}

        {/* Team Section */}
        {currentTeam && (
          <section>
            <div className="flex items-center justify-between mb-4">
              <h2 className="section-label">Your Team</h2>
              <Link
                href={`/app/teams/${currentTeam.id}`}
                className="text-xs text-text-secondary hover:text-text-primary transition-colors"
              >
                Manage
              </Link>
            </div>
            <div className="card divide-y divide-border-default">
              {teamMembersList.length === 0 ? (
                <div className="p-4 text-sm text-text-muted text-center">No team members found</div>
              ) : (
                teamMembersList.map((member: any) => (
                  <div key={member.userId} className="flex items-center gap-3 px-4 py-3">
                    <div className="w-8 h-8 rounded-full bg-surface-3 flex items-center justify-center shrink-0">
                      <span className="text-xs font-medium text-text-secondary">
                        {member.user?.name?.[0]?.toUpperCase() || member.user?.email?.[0]?.toUpperCase() || '?'}
                      </span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-text-primary truncate">{member.user?.name || member.user?.email || 'Unknown'}</p>
                    </div>
                    <span className={`px-2 py-0.5 text-[11px] font-mono rounded-full ${roleColors[member.role] || roleColors.member}`}>
                      {member.role}
                    </span>
                  </div>
                ))
              )}
              <div className="px-4 py-3">
                <Link
                  href={`/app/teams/${currentTeam.id}`}
                  className="text-xs text-primary hover:underline"
                >
                  + Invite someone
                </Link>
              </div>
            </div>
          </section>
        )}

        {/* Runners Section */}
        <section>
          <h2 className="section-label mb-4">Runners</h2>
          <div className="card">
            {heartbeats.length === 0 ? (
              <div className="p-4 text-center">
                <p className="text-sm text-text-muted">No runners connected</p>
                <p className="text-xs text-text-muted mt-1">Runners appear here when they send heartbeats.</p>
              </div>
            ) : (
              <div className="divide-y divide-border-default">
                {heartbeats.map((hb: any) => {
                  const isOnline = (Date.now() - new Date(hb.lastHeartbeatAt).getTime()) < 10 * 60 * 1000;
                  return (
                    <div key={hb.id} className="flex items-center gap-3 px-4 py-3">
                      <span className={`glow-dot ${isOnline ? 'glow-dot-success' : ''}`}
                        style={!isOnline ? { background: 'var(--text-muted)' } : undefined}
                      />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm text-text-primary truncate">
                          {hb.account?.name || 'Runner'}
                        </p>
                        <p className="text-xs text-text-muted">
                          {hb.activeWorkerCount}/{hb.maxConcurrentWorkers} active
                        </p>
                      </div>
                      <span className="text-[10px] font-mono text-text-muted shrink-0">
                        heartbeat {timeAgo(new Date(hb.lastHeartbeatAt))}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </section>

        {/* GitHub Section (full management) */}
        <GitHubSection />

        {/* API Keys Section (full management) */}
        <ApiKeysSection
          accounts={allAccounts.map((a: any) => ({ ...a, hasOauthToken: !!a.oauthToken }))}
          workspaces={userWorkspaces.map(ws => ({ id: ws.id, name: ws.name, repo: ws.repo }))}
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

          {userTeams.length === 0 ? (
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

        {/* Workspaces */}
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
