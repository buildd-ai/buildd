import { db } from '@buildd/core/db';
import { accounts, workspaces, workerHeartbeats, accountWorkspaces, tasks, workspaceSkills } from '@buildd/core/db/schema';
import { desc, inArray, and, gt, sql, eq } from 'drizzle-orm';
import { cookies } from 'next/headers';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth-helpers';
import { getUserWorkspaceIds, getUserTeamsWithDetails, type UserTeam } from '@/lib/team-access';
import { isSystemWorkspace } from '@buildd/shared';
import { TeamSwitcher } from '@/components/TeamSwitcher';
import GitHubSection from './GitHubSection';
import VercelSection from './VercelSection';
import ApiKeysSection from './ApiKeysSection';
import ConnectClaudeSection from './ConnectClaudeSection';
import AgentBackendsSection from './AgentBackendsSection';
import NotificationsSection from './NotificationsSection';
import SignOutButton from '../you/SignOutButton';

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

export default async function SettingsPage() {
  const user = await getCurrentUser();

  if (!user) {
    redirect('/app/auth/signin');
  }

  let userTeams: UserTeam[] = [];
  let teamsError = false;
  let wsIds: string[] = [];

  try {
    [userTeams, wsIds] = await Promise.all([
      getUserTeamsWithDetails(user.id),
      getUserWorkspaceIds(user.id),
    ]);
  } catch (error) {
    console.error('Settings: teams/workspace query error:', error);
    teamsError = true;
  }

  const teamIds = userTeams.map(t => t.id);

  const cookieStore = await cookies();
  const teamCookie = cookieStore.get('buildd-team')?.value;
  const currentTeamId = (teamCookie && userTeams.some(t => t.id === teamCookie))
    ? teamCookie
    : userTeams[0]?.id || null;

  // Parallel data fetches
  const [allAccounts, userWorkspaces, heartbeats, usageStats] = await Promise.all([
    // API keys/accounts
    teamIds.length > 0
      ? db.query.accounts.findMany({
          where: inArray(accounts.teamId, teamIds),
          orderBy: desc(accounts.createdAt),
          with: {
            team: { columns: { name: true } },
            accountWorkspaces: { columns: { workspaceId: true } },
          },
        }).catch(() => [] as any[])
      : Promise.resolve([] as any[]),

    // User workspaces
    wsIds.length > 0
      ? db.query.workspaces.findMany({
          where: inArray(workspaces.id, wsIds),
          columns: { id: true, name: true, repo: true, teamId: true },
        }).catch(() => [] as any[])
      : Promise.resolve([] as any[]),

    // Runner heartbeats
    wsIds.length > 0
      ? (async () => {
          const workspaceLinkedAccounts = await db
            .select({ accountId: accountWorkspaces.accountId })
            .from(accountWorkspaces)
            .where(inArray(accountWorkspaces.workspaceId, wsIds));
          const linkedAccountIds = [...new Set(workspaceLinkedAccounts.map(r => r.accountId))];

          const teamAccountIds = teamIds.length > 0
            ? (await db.query.accounts.findMany({
                where: inArray(accounts.teamId, teamIds),
                columns: { id: true },
              })).map(a => a.id)
            : [];

          const allAccountIds = [...new Set([...linkedAccountIds, ...teamAccountIds])];
          if (allAccountIds.length === 0) return [];

          const cutoff = new Date(Date.now() - 150 * 60 * 1000);
          return db.query.workerHeartbeats.findMany({
            where: and(
              inArray(workerHeartbeats.accountId, allAccountIds),
              gt(workerHeartbeats.lastHeartbeatAt, cutoff),
            ),
            orderBy: desc(workerHeartbeats.lastHeartbeatAt),
            with: { account: { columns: { name: true } } },
          });
        })().catch(() => [] as any[])
      : Promise.resolve([] as any[]),

    // Usage stats (last 30 days)
    wsIds.length > 0
      ? (async () => {
          const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
          const recentTasks = await db.query.tasks.findMany({
            where: and(
              inArray(tasks.workspaceId, wsIds),
              sql`${tasks.createdAt} >= ${thirtyDaysAgo}`,
            ),
            columns: { roleSlug: true, status: true },
          });

          const byRole: Record<string, { completed: number; failed: number; total: number }> = {};
          let totalCompleted = 0;
          let totalFailed = 0;
          let unassigned = 0;

          for (const t of recentTasks) {
            if (t.status === 'completed') totalCompleted++;
            if (t.status === 'failed') totalFailed++;
            if (t.roleSlug) {
              if (!byRole[t.roleSlug]) byRole[t.roleSlug] = { completed: 0, failed: 0, total: 0 };
              byRole[t.roleSlug].total++;
              if (t.status === 'completed') byRole[t.roleSlug].completed++;
              if (t.status === 'failed') byRole[t.roleSlug].failed++;
            } else {
              unassigned++;
            }
          }

          const roleSlugs = Object.keys(byRole);
          let roleInfo: Record<string, { name: string; color: string }> = {};
          if (roleSlugs.length > 0) {
            const skills = await db.query.workspaceSkills.findMany({
              where: and(
                inArray(workspaceSkills.workspaceId, wsIds),
                eq(workspaceSkills.isRole, true),
                inArray(workspaceSkills.slug, roleSlugs),
              ),
              columns: { slug: true, name: true, color: true },
            });
            for (const s of skills) {
              roleInfo[s.slug] = { name: s.name, color: s.color };
            }
          }

          return {
            total: recentTasks.length,
            completed: totalCompleted,
            failed: totalFailed,
            unassigned,
            byRole: Object.entries(byRole)
              .sort((a, b) => b[1].total - a[1].total)
              .map(([slug, stats]) => ({
                slug,
                name: roleInfo[slug]?.name || slug,
                color: roleInfo[slug]?.color || '#888',
                ...stats,
              })),
          };
        })().catch(() => null)
      : Promise.resolve(null),
  ]);

  const roleColors: Record<string, string> = {
    owner: 'bg-primary/10 text-primary',
    admin: 'bg-status-info/10 text-status-info',
    member: 'bg-surface-3 text-text-primary',
  };

  const initials = user.name
    ? user.name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2)
    : user.email[0].toUpperCase();

  const filteredWorkspaces = userWorkspaces.filter(ws => !isSystemWorkspace(ws.name));

  return (
    <main className="min-h-screen pt-14 px-4 pb-24 md:p-8 md:pb-8">
      <div className="max-w-2xl mx-auto space-y-10">

        {/* Profile */}
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

        {/* Switch Team (mobile only, if multiple teams) */}
        {userTeams.length > 1 && (
          <section className="md:hidden">
            <h2 className="section-label mb-3">Switch Team</h2>
            <div className="card p-3">
              <TeamSwitcher teams={userTeams} currentTeamId={currentTeamId} />
            </div>
          </section>
        )}

        {/* Agent Backends */}
        <AgentBackendsSection
          workspaces={filteredWorkspaces}
          currentTeamId={currentTeamId}
        />

        {/* Notifications */}
        <NotificationsSection
          workspaces={filteredWorkspaces}
          currentTeamId={currentTeamId}
        />

        {/* Runners */}
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
                  const isOnline = (Date.now() - new Date(hb.lastHeartbeatAt).getTime()) < 2 * 60 * 1000;
                  return (
                    <div key={hb.id} className="flex items-center gap-3 px-4 py-3">
                      <span
                        className={`glow-dot ${isOnline ? 'glow-dot-success' : ''}`}
                        style={!isOnline ? { background: 'var(--text-muted)' } : undefined}
                      />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <p className="text-sm text-text-primary truncate">
                            {hb.account?.name || 'Runner'}
                          </p>
                          <span className={`text-[10px] font-mono ${isOnline ? 'text-status-success' : 'text-text-muted'}`}>
                            {isOnline ? 'online' : 'stale'}
                          </span>
                        </div>
                        <p className="text-xs text-text-muted">
                          {hb.activeWorkerCount}/{hb.maxConcurrentWorkers} workers · last beat {timeAgo(new Date(hb.lastHeartbeatAt))}
                        </p>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </section>

        {/* Usage (30d) */}
        {usageStats && usageStats.total > 0 && (
          <section>
            <h2 className="section-label mb-4">Usage (30d)</h2>
            <div className="card p-4 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-sm text-text-secondary">{usageStats.total} tasks</span>
                <div className="flex items-center gap-3 text-xs">
                  <span className="text-status-success">{usageStats.completed} done</span>
                  {usageStats.failed > 0 && <span className="text-status-error">{usageStats.failed} failed</span>}
                </div>
              </div>
              {usageStats.byRole.length > 0 && (
                <div className="space-y-2 pt-1">
                  {usageStats.byRole.map((r: any) => (
                    <div key={r.slug} className="flex items-center gap-2">
                      <div className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: r.color }} />
                      <span className="text-xs text-text-primary flex-1 truncate">{r.name}</span>
                      <span className="text-xs text-text-muted tabular-nums">
                        {r.completed} done{r.failed > 0 ? ` / ${r.failed} failed` : ''}
                      </span>
                    </div>
                  ))}
                  {usageStats.unassigned > 0 && (
                    <div className="flex items-center gap-2">
                      <div className="w-2 h-2 rounded-full shrink-0 bg-text-muted" />
                      <span className="text-xs text-text-muted flex-1">No role</span>
                      <span className="text-xs text-text-muted tabular-nums">{usageStats.unassigned}</span>
                    </div>
                  )}
                </div>
              )}
            </div>
          </section>
        )}

        {/* Workspaces */}
        {filteredWorkspaces.length > 0 && (
          <section>
            <h2 className="section-label mb-4">Workspaces</h2>
            <div className="card divide-y divide-border-default">
              {filteredWorkspaces.map((ws) => (
                <Link
                  key={ws.id}
                  href={`/app/workspaces/${ws.id}/skills`}
                  className="flex items-center justify-between p-4 hover:bg-surface-3/50 transition-colors first:rounded-t-[10px] last:rounded-b-[10px]"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">{ws.name}</p>
                    {ws.repo && <p className="text-xs text-text-muted truncate">{ws.repo}</p>}
                  </div>
                  <span className="text-xs text-text-muted flex-shrink-0">Roles, backend, integrations</span>
                </Link>
              ))}
            </div>
          </section>
        )}

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

        {/* Browse */}
        <section>
          <h2 className="section-label mb-4">Browse</h2>
          <div className="card divide-y divide-border-default">
            <Link href="/app/artifacts" className="flex items-center gap-3 px-4 py-3 hover:bg-surface-3/50 transition-colors rounded-t-[10px] rounded-b-[10px]">
              <svg className="w-4 h-4 text-text-muted shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
                <polyline points="14,2 14,8 20,8" />
              </svg>
              <span className="text-sm text-text-primary">Artifacts</span>
              <svg className="w-3.5 h-3.5 text-text-muted ml-auto shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 18l6-6-6-6"/></svg>
            </Link>
          </div>
        </section>

        {/* Integrations (collapsed) */}
        <section>
          <details className="group">
            <summary className="flex items-center justify-between cursor-pointer list-none select-none">
              <h2 className="section-label">Integrations</h2>
              <span className="flex items-center gap-1.5 text-xs text-text-muted">
                GitHub · Vercel · API keys · Claude connector
                <svg className="w-4 h-4 transition-transform group-open:rotate-180" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </span>
            </summary>

            <div className="mt-6 space-y-12">
              <GitHubSection />

              <ConnectClaudeSection
                workspaces={filteredWorkspaces}
              />

              <VercelSection teams={userTeams.map(t => ({ id: t.id, name: t.name }))} />

              <ApiKeysSection
                accounts={allAccounts.map(a => ({ ...a, hasOauthToken: !!a.oauthToken }))}
                workspaces={filteredWorkspaces}
              />
            </div>
          </details>
        </section>

      </div>
    </main>
  );
}
