import { db } from '@buildd/core/db';
import { accounts, workers, workspaces } from '@buildd/core/db/schema';
import { and, desc, eq, gte, inArray } from 'drizzle-orm';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth-helpers';
import { getUserWorkspaceIds, getUserTeamsWithDetails } from '@/lib/team-access';
import WorkspaceList from './WorkspaceList';
import { PageContent } from '@/components/PageContent';

interface WorkspaceWithRunners {
  id: string;
  name: string;
  repo: string | null;
  localPath: string | null;
  createdAt: Date;
  teamName: string | null;
  teamId: string | null;
  runners: {
    action: boolean;
    service: boolean;
    user: boolean;
  };
}

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="currentColor" width="16" height="16">
      <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
    </svg>
  );
}

function XIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="currentColor" width="16" height="16">
      <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
    </svg>
  );
}

export default async function WorkspacesPage() {
  const isDev = process.env.NODE_ENV === 'development';
  const user = await getCurrentUser();

  let allWorkspaces: WorkspaceWithRunners[] = [];
  let userTeams: any[] = [];

  if (!isDev) {
    if (!user) {
      redirect('/app/auth/signin');
    }

    try {
      const wsIds = await getUserWorkspaceIds(user.id);
      const rawWorkspaces = wsIds.length > 0 ? await db.query.workspaces.findMany({
        where: inArray(workspaces.id, wsIds),
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
          runners: {
            action: connectedAccounts.some((aw) => aw.account?.type === 'action' && aw.canClaim) || !!activeTypes?.has('action'),
            service: connectedAccounts.some((aw) => aw.account?.type === 'service' && aw.canClaim) || !!activeTypes?.has('service'),
            user: connectedAccounts.some((aw) => aw.account?.type === 'user' && aw.canClaim) || !!activeTypes?.has('user'),
          },
        };
      });

      userTeams = await getUserTeamsWithDetails(user.id);
    } catch (error) {
      console.error('Workspaces query error:', error);
    }
  }

  return (
    <PageContent>
        <div className="flex justify-between items-center mb-8">
          <div>
            <Link href="/app/dashboard" className="text-sm text-text-muted hover:text-text-secondary mb-2 block">
              ← Dashboard
            </Link>
            <h1 className="text-3xl font-bold">Workspaces</h1>
          </div>
          <Link
            href="/app/workspaces/new"
            className="px-4 py-2 bg-primary text-white hover:bg-primary-hover rounded-lg"
          >
            + New Workspace
          </Link>
        </div>

        <WorkspaceList workspaces={allWorkspaces} teams={userTeams} />
    </PageContent>
  );
}
