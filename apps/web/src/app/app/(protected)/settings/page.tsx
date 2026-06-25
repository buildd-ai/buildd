import { db } from '@buildd/core/db';
import { accounts, workspaces } from '@buildd/core/db/schema';
import { desc, inArray } from 'drizzle-orm';
import { cookies } from 'next/headers';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth-helpers';
import { getUserWorkspaceIds, getUserTeamsWithDetails } from '@/lib/team-access';
import { isSystemWorkspace } from '@buildd/shared';
import GitHubSection from './GitHubSection';
import VercelSection from './VercelSection';
import RunnerTokensSection from './RunnerTokensSection';
import AgentBackendsSection from './AgentBackendsSection';
import NotificationsSection from './NotificationsSection';

export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  const user = await getCurrentUser();

  if (!user) {
    redirect('/app/auth/signin');
  }

  let userTeams: Awaited<ReturnType<typeof getUserTeamsWithDetails>> = [];
  let wsIds: string[] = [];

  try {
    [userTeams, wsIds] = await Promise.all([
      getUserTeamsWithDetails(user.id),
      getUserWorkspaceIds(user.id),
    ]);
  } catch (error) {
    console.error('Settings: teams/workspace query error:', error);
  }

  const teamIds = userTeams.map(t => t.id);

  const cookieStore = await cookies();
  const teamCookie = cookieStore.get('buildd-team')?.value;
  const currentTeamId = (teamCookie && userTeams.some(t => t.id === teamCookie))
    ? teamCookie
    : userTeams[0]?.id || null;

  const [allAccounts, userWorkspaces] = await Promise.all([
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

    wsIds.length > 0
      ? db.query.workspaces.findMany({
          where: inArray(workspaces.id, wsIds),
          columns: { id: true, name: true, repo: true, teamId: true },
        }).catch(() => [] as any[])
      : Promise.resolve([] as any[]),
  ]);

  const filteredWorkspaces = userWorkspaces.filter((ws: any) => !isSystemWorkspace(ws.name));

  return (
    <main className="min-h-screen pt-14 px-4 pb-24 md:p-8 md:pb-8">
      <div className="max-w-2xl mx-auto space-y-10">

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

        {/* GitHub */}
        <GitHubSection />

        {/* Vercel */}
        <VercelSection teams={userTeams.map(t => ({ id: t.id, name: t.name }))} />

        {/* Runner Tokens */}
        <RunnerTokensSection
          accounts={allAccounts.map((a: any) => ({ ...a, hasOauthToken: !!a.oauthToken }))}
          workspaces={filteredWorkspaces}
        />

        {/* Workspaces */}
        <section>
          <div className="flex justify-between items-center mb-4">
            <h2 className="section-label">Workspaces</h2>
            <Link
              href="/app/workspaces/new"
              className="text-sm text-text-secondary hover:text-text-primary transition-colors"
            >
              + New Workspace
            </Link>
          </div>
          {filteredWorkspaces.length > 0 ? (
            <div className="card divide-y divide-border-default">
              {filteredWorkspaces.map((ws: any) => (
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
          ) : (
            <div className="card p-6 text-center">
              <p className="text-text-muted text-sm mb-3">
                No workspaces yet. A workspace connects a repo so agents can work on it.
              </p>
              <Link href="/app/workspaces/new" className="text-sm text-primary hover:underline">
                Connect or create a repo &rarr;
              </Link>
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

      </div>
    </main>
  );
}
