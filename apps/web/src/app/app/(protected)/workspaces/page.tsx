import { db } from '@buildd/core/db';
import { accounts, workers, workspaces } from '@buildd/core/db/schema';
import { and, desc, eq, gte, inArray } from 'drizzle-orm';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { getCurrentUser } from '@/lib/auth-helpers';
import { getUserWorkspaceIds, getUserTeamsWithDetails, resolveActiveTeamId } from '@/lib/team-access';
import { isSystemWorkspace } from '@buildd/shared';
import { moveTargets } from '../settings/workspaces/rows';
import WorkspaceList, { type WorkspaceWithRunners } from './WorkspaceList';

export default async function WorkspacesPage() {
  const isDev = process.env.NODE_ENV === 'development' && (!process.env.DATABASE_URL || !process.env.DEV_USER_EMAIL); // placeholder unless dev has a DB + dev user
  const user = await getCurrentUser();

  let allWorkspaces: WorkspaceWithRunners[] = [];
  let moveTeams: Array<{ id: string; name: string }> = [];

  if (!isDev) {
    if (!user) {
      redirect('/app/auth/signin');
    }

    try {
      const wsIds = await getUserWorkspaceIds(user.id);
      // Namespace to the active team (buildd-team cookie). null active team
      // (user in no team) leaves the list empty rather than leaking all teams.
      const cookieStore = await cookies();
      const activeTeamId = await resolveActiveTeamId(user.id, cookieStore.get('buildd-team')?.value);
      const rawWorkspaces = (wsIds.length > 0 && activeTeamId) ? await db.query.workspaces.findMany({
        where: and(inArray(workspaces.id, wsIds), eq(workspaces.teamId, activeTeamId)),
        orderBy: desc(workspaces.createdAt),
        with: {
          team: { columns: { id: true, name: true } },
          accountWorkspaces: {
            with: {
              account: true,
            },
          },
        },
      }) : [];

      // For open-access workspaces, also check recent worker activity
      const openWsIds = rawWorkspaces
        .filter((ws) => ws.accessMode === 'open')
        .map((ws) => ws.id);

      const activityByWorkspace = new Map<string, Set<string>>();
      if (openWsIds.length > 0) {
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

        const recentActivity = await db
          .select({
            workspaceId: workers.workspaceId,
            accountType: accounts.type,
          })
          .from(workers)
          .innerJoin(accounts, eq(workers.accountId, accounts.id))
          .where(
            and(
              inArray(workers.workspaceId, openWsIds),
              gte(workers.createdAt, thirtyDaysAgo),
            ),
          )
          .groupBy(workers.workspaceId, accounts.type);

        for (const row of recentActivity) {
          if (!activityByWorkspace.has(row.workspaceId)) {
            activityByWorkspace.set(row.workspaceId, new Set());
          }
          activityByWorkspace.get(row.workspaceId)!.add(row.accountType);
        }
      }

      const userTeams = await getUserTeamsWithDetails(user.id);
      // Admin on the workspace's team and one other: the bar the precheck sets.
      const targetsFor = (teamId: string | null) => (teamId ? moveTargets(user.id, userTeams, teamId) : null);
      moveTeams = rawWorkspaces.map((ws) => targetsFor(ws.teamId)).find((t) => t !== null) ?? [];

      allWorkspaces = rawWorkspaces.map((ws) => {
        const connectedAccounts = ws.accountWorkspaces || [];
        const activeTypes = activityByWorkspace.get(ws.id);
        return {
          id: ws.id,
          name: ws.name,
          repo: ws.repo,
          localPath: ws.localPath,
          createdAt: ws.createdAt,
          teamName: ws.team?.name || null,
          teamId: ws.team?.id || null,
          canMove: targetsFor(ws.team?.id ?? null) !== null,
          runners: {
            service: connectedAccounts.some((aw) => aw.account?.type === 'service' && aw.canClaim) || !!activeTypes?.has('service'),
            user: connectedAccounts.some((aw) => aw.account?.type === 'user' && aw.canClaim) || !!activeTypes?.has('user'),
          },
        };
      });

    } catch (error) {
      console.error('Workspaces query error:', error);
    }
  }

  return (
    <main className="min-h-screen pt-14 px-4 pb-8 md:p-8">
      <div className="max-w-4xl mx-auto">
        <Link href="/app/home" className="text-sm text-text-muted hover:text-text-secondary mb-2 inline-block">
          ← Home
        </Link>
        <div className="flex flex-wrap justify-between items-center gap-3 mb-8">
          <h1 className="text-2xl md:text-3xl font-bold min-w-0">Workspaces</h1>
          <Link
            href="/app/workspaces/new"
            className="shrink-0 whitespace-nowrap px-3 py-2 md:px-4 text-sm md:text-base bg-primary text-white hover:bg-primary-hover rounded-lg"
          >
            + New Workspace
          </Link>
        </div>

        <WorkspaceList workspaces={allWorkspaces.filter(ws => !isSystemWorkspace(ws.name))} moveTeams={moveTeams} />
      </div>
    </main>
  );
}
