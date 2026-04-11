import { db } from '@buildd/core/db';
import { accounts, workspaces, workerHeartbeats, teamMembers, users, tasks, workspaceSkills } from '@buildd/core/db/schema';
import { eq, and, inArray, desc, sql } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth-helpers';
import { getUserTeamsWithDetails, getUserWorkspaceIds, type UserTeam } from '@/lib/team-access';
import SignOutButton from './SignOutButton';
import Link from 'next/link';

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

  // Fetch all data in parallel
  const [userTeams, wsIds] = await Promise.all([
    getUserTeamsWithDetails(user.id).catch(() => [] as UserTeam[]),
    getUserWorkspaceIds(user.id).catch(() => [] as string[]),
  ]);

  const teamIds = userTeams.map(t => t.id);

  // Parallel data fetches
  const [teamMembersList, allAccounts, heartbeats, userWorkspaces, usageStats] = await Promise.all([
    // Team members for first team
    teamIds.length > 0
      ? db.query.teamMembers.findMany({
          where: eq(teamMembers.teamId, teamIds[0]),
          with: { user: { columns: { id: true, name: true, email: true, image: true } } },
        }).catch(() => [])
      : Promise.resolve([]),

    // API keys/accounts
    teamIds.length > 0
      ? db.query.accounts.findMany({
          where: inArray(accounts.teamId, teamIds),
          orderBy: desc(accounts.createdAt),
          columns: {
            id: true, name: true, apiKeyPrefix: true, level: true, authType: true, createdAt: true, teamId: true,
          },
          with: { team: { columns: { name: true } } },
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

    // Workspaces for connections
    wsIds.length > 0
      ? db.query.workspaces.findMany({
          where: inArray(workspaces.id, wsIds),
          columns: { id: true, name: true, repo: true, githubInstallationId: true },
        }).catch(() => [])
      : Promise.resolve([]),

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

          // Get role names/colors for display
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

  const currentTeam = userTeams[0];

  return (
    <main className="min-h-screen pt-14 px-4 pb-4 md:p-8">
      <div className="max-w-2xl mx-auto space-y-8">

        {/* Profile Section */}
        <section>
          <h2 className="section-label mb-4">Profile</h2>
          <div className="card p-5">
            <div className="flex items-center gap-4">
              {/* Avatar */}
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
                  href={currentTeam ? `/app/teams/${currentTeam.id}` : '/app/settings'}
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
                  const isOnline = (Date.now() - new Date(hb.lastHeartbeatAt).getTime()) < 10 * 60 * 1000; // 10 min
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

        {/* Usage Section */}
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
                  {usageStats.byRole.map((r) => (
                    <div key={r.slug} className="flex items-center gap-2">
                      <div
                        className="w-2 h-2 rounded-full shrink-0"
                        style={{ backgroundColor: r.color }}
                      />
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

        {/* Connections Section */}
        <section>
          <h2 className="section-label mb-4">Connections</h2>
          <div className="card divide-y divide-border-default">
            {/* GitHub */}
            <div className="flex items-center gap-3 px-4 py-3">
              <svg className="w-5 h-5 text-text-secondary shrink-0" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
              </svg>
              <div className="flex-1 min-w-0">
                <p className="text-sm text-text-primary">GitHub</p>
                {userWorkspaces.some((ws: any) => ws.githubInstallationId) ? (
                  <p className="text-xs text-status-success">Connected</p>
                ) : (
                  <p className="text-xs text-text-muted">Not connected</p>
                )}
              </div>
              <Link href="/app/settings" className="text-xs text-text-secondary hover:text-text-primary">
                Configure
              </Link>
            </div>

            {/* Other services placeholder */}
            <div className="flex items-center gap-3 px-4 py-3">
              <svg className="w-5 h-5 text-text-muted shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M13.19 8.688a4.5 4.5 0 011.242 7.244l-4.5 4.5a4.5 4.5 0 01-6.364-6.364l1.757-1.757m13.35-.622l1.757-1.757a4.5 4.5 0 00-6.364-6.364l-4.5 4.5a4.5 4.5 0 001.242 7.244" />
              </svg>
              <div className="flex-1">
                <p className="text-sm text-text-muted">More integrations coming soon</p>
              </div>
            </div>
          </div>
        </section>

        {/* API Keys Section */}
        <section>
          <div className="flex items-center justify-between mb-4">
            <h2 className="section-label">API Keys</h2>
            <Link
              href="/app/settings"
              className="text-xs text-text-secondary hover:text-text-primary transition-colors"
            >
              Manage
            </Link>
          </div>
          <div className="card">
            {allAccounts.length === 0 ? (
              <div className="p-4 text-center">
                <p className="text-sm text-text-muted">No API keys</p>
                <Link href="/app/settings" className="text-xs text-primary hover:underline mt-1 inline-block">
                  + Create key
                </Link>
              </div>
            ) : (
              <div className="divide-y divide-border-default">
                {allAccounts.slice(0, 5).map((acct: any) => (
                  <div key={acct.id} className="flex items-center gap-3 px-4 py-3">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-text-primary truncate">{acct.name}</p>
                      <p className="text-xs font-mono text-text-muted">
                        {acct.apiKeyPrefix ? `${acct.apiKeyPrefix}...` : 'bld_***'}
                      </p>
                    </div>
                    <span className="text-[10px] font-mono text-text-muted px-1.5 py-0.5 bg-surface-3 rounded shrink-0">
                      {acct.level}
                    </span>
                    <span className="text-[10px] font-mono text-text-muted shrink-0">
                      {new Date(acct.createdAt).toLocaleDateString()}
                    </span>
                  </div>
                ))}
                {allAccounts.length > 5 && (
                  <div className="px-4 py-2">
                    <Link href="/app/settings" className="text-xs text-primary hover:underline">
                      View all {allAccounts.length} keys
                    </Link>
                  </div>
                )}
              </div>
            )}
          </div>
        </section>

      </div>
    </main>
  );
}
