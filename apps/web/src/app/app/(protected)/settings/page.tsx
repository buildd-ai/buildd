import { db } from '@buildd/core/db';
import { accounts, workspaces } from '@buildd/core/db/schema';
import { desc, inArray } from 'drizzle-orm';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth-helpers';
import { getUserWorkspaceIds, getUserTeamsWithDetails } from '@/lib/team-access';
import { isSystemWorkspace } from '@buildd/shared';
import GitHubSection from './GitHubSection';
import VercelSection from './VercelSection';
import RunnerTokensSection from './RunnerTokensSection';
import AgentBackendsSection from './AgentBackendsSection';
import NotificationsSection from './NotificationsSection';
import ConnectorsSection from './ConnectorsSection';
import WorkspaceMigrationSection from './WorkspaceMigrationSection';

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

        {/* Connectors */}
        <ConnectorsSection workspaces={filteredWorkspaces.map((ws: any) => ({ id: ws.id, name: ws.name }))} />

        {/* Runner Tokens */}
        <RunnerTokensSection
          accounts={allAccounts.map((a: any) => ({ ...a, hasOauthToken: !!a.oauthToken }))}
          workspaces={filteredWorkspaces}
        />

        {/* Workspace Migration (Danger Zone) */}
        <WorkspaceMigrationSection
          workspaces={filteredWorkspaces.map((ws: any) => ({ id: ws.id, name: ws.name, teamId: ws.teamId }))}
          teams={userTeams.map(t => ({ id: t.id, name: t.name }))}
        />

      </div>
    </main>
  );
}
