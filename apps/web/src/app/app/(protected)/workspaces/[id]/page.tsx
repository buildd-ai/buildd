import { db } from '@buildd/core/db';
import { workspaces, tasks, accountWorkspaces, observations, taskSchedules } from '@buildd/core/db/schema';
import { eq, desc, and, count } from 'drizzle-orm';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { ConnectRunnerSection } from './connect-runner';
import DeleteWorkspaceButton from './DeleteWorkspaceButton';
import { getCurrentUser } from '@/lib/auth-helpers';
import { verifyWorkspaceAccess } from '@/lib/team-access';

export default async function WorkspaceDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const isDev = process.env.NODE_ENV === 'development';
  const user = await getCurrentUser();

  if (isDev) {
    return (
      <main className="min-h-screen p-8">
        <div className="max-w-4xl mx-auto">
          <p className="text-text-muted">Development mode - no database</p>
        </div>
      </main>
    );
  }

  if (!user) {
    redirect('/app/auth/signin');
  }

  const access = await verifyWorkspaceAccess(user.id, id);
  if (!access) notFound();

  const workspace = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, id),
    with: {
      accountWorkspaces: {
        with: {
          account: true,
        },
      },
      tasks: {
        orderBy: desc(tasks.createdAt),
        limit: 5,
      },
    },
  });

  if (!workspace) {
    notFound();
  }

  const connectedAccounts = workspace.accountWorkspaces || [];
  const runners = {
    action: connectedAccounts.filter((aw) => aw.account?.type === 'action' && aw.canClaim),
    service: connectedAccounts.filter((aw) => aw.account?.type === 'service' && aw.canClaim),
    user: connectedAccounts.filter((aw) => aw.account?.type === 'user' && aw.canClaim),
  };

  const taskCounts = await db
    .select({ status: tasks.status, count: count() })
    .from(tasks)
    .where(eq(tasks.workspaceId, id))
    .groupBy(tasks.status);

  const taskCountMap = Object.fromEntries(taskCounts.map((t) => [t.status, Number(t.count)]));

  const [obsCount] = await db
    .select({ count: count() })
    .from(observations)
    .where(eq(observations.workspaceId, id));
  const observationCount = Number(obsCount?.count || 0);

  const [schedCount] = await db
    .select({ count: count() })
    .from(taskSchedules)
    .where(eq(taskSchedules.workspaceId, id));
  const scheduleCount = Number(schedCount?.count || 0);

  return (
    <main className="min-h-screen p-8">
      <div className="max-w-4xl mx-auto">
        <Link href="/app/workspaces" className="text-sm text-text-muted hover:text-text-secondary mb-2 block">
          &larr; Workspaces
        </Link>

        <div className="flex justify-between items-start mb-8">
          <div>
            <h1 className="text-3xl font-bold">{workspace.name}</h1>
            {workspace.repo && (
              <p className="text-text-muted mt-1">{workspace.repo}</p>
            )}
          </div>
          <div className="flex gap-2">
            <Link
              href={`/app/workspaces/${workspace.id}/schedules`}
              className="px-4 py-2 border border-border-default rounded-lg hover:bg-surface-3"
            >
              Schedules{scheduleCount > 0 ? ` (${scheduleCount})` : ''}
            </Link>
            <Link
              href={`/app/workspaces/${workspace.id}/memory`}
              className="px-4 py-2 border border-border-default rounded-lg hover:bg-surface-3"
            >
              Memory{observationCount > 0 ? ` (${observationCount})` : ''}
            </Link>
            <Link
              href={`/app/workspaces/${workspace.id}/config`}
              className="px-4 py-2 border border-border-default rounded-lg hover:bg-surface-3"
            >
              Configure
            </Link>
            <DeleteWorkspaceButton workspaceId={workspace.id} workspaceName={workspace.name} />
            <Link
              href={`/app/tasks/new?workspaceId=${workspace.id}`}
              className="px-4 py-2 bg-primary text-white hover:bg-primary-hover rounded-lg"
            >
              + New Task
            </Link>
          </div>
        </div>

        {/* Task Stats */}
        <div className="grid grid-cols-4 gap-4 mb-8">
          <div className="border border-border-default rounded-lg p-4">
            <div className="text-2xl font-bold">{taskCountMap['pending'] || 0}</div>
            <div className="text-sm text-text-muted">Pending</div>
          </div>
          <div className="border border-border-default rounded-lg p-4">
            <div className="text-2xl font-bold">{taskCountMap['assigned'] || 0}</div>
            <div className="text-sm text-text-muted">Assigned</div>
          </div>
          <div className="border border-border-default rounded-lg p-4">
            <div className="text-2xl font-bold">{taskCountMap['completed'] || 0}</div>
            <div className="text-sm text-text-muted">Completed</div>
          </div>
          <div className="border border-border-default rounded-lg p-4">
            <div className="text-2xl font-bold">{taskCountMap['failed'] || 0}</div>
            <div className="text-sm text-text-muted">Failed</div>
          </div>
        </div>

        {/* Connected Runners */}
        <div className="mb-8">
          <h2 className="text-xl font-semibold mb-4">Connected Runners</h2>

          <div className="space-y-4">
            {/* GitHub Actions */}
            <div className="border border-border-default rounded-lg p-4">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <span className={`inline-flex items-center justify-center w-6 h-6 rounded-full ${runners.action.length > 0 ? 'bg-status-success/10 text-status-success' : 'bg-surface-3 text-text-muted'}`}>
                    {runners.action.length > 0 ? (
                      <svg viewBox="0 0 20 20" fill="currentColor" width="14" height="14">
                        <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                      </svg>
                    ) : (
                      <svg viewBox="0 0 20 20" fill="currentColor" width="14" height="14">
                        <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
                      </svg>
                    )}
                  </span>
                  <span className="font-medium">GitHub Actions</span>
                  <span className={`px-2 py-0.5 text-xs rounded-full ${runners.action.length > 0 ? 'bg-status-warning/10 text-status-warning' : 'bg-surface-3 text-text-secondary'}`}>
                    {runners.action.length} connected
                  </span>
                </div>
              </div>
              {runners.action.length > 0 ? (
                <div className="text-sm text-text-muted">
                  {runners.action.map((r) => r.account?.name).join(', ')}
                </div>
              ) : (
                <p className="text-sm text-text-muted">No GitHub Action runners connected yet</p>
              )}
            </div>

            {/* Service Workers */}
            <div className="border border-border-default rounded-lg p-4">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <span className={`inline-flex items-center justify-center w-6 h-6 rounded-full ${runners.service.length > 0 ? 'bg-status-success/10 text-status-success' : 'bg-surface-3 text-text-muted'}`}>
                    {runners.service.length > 0 ? (
                      <svg viewBox="0 0 20 20" fill="currentColor" width="14" height="14">
                        <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                      </svg>
                    ) : (
                      <svg viewBox="0 0 20 20" fill="currentColor" width="14" height="14">
                        <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
                      </svg>
                    )}
                  </span>
                  <span className="font-medium">Service Workers</span>
                  <span className={`px-2 py-0.5 text-xs rounded-full ${runners.service.length > 0 ? 'bg-primary/10 text-primary' : 'bg-surface-3 text-text-secondary'}`}>
                    {runners.service.length} connected
                  </span>
                </div>
              </div>
              {runners.service.length > 0 ? (
                <div className="text-sm text-text-muted">
                  {runners.service.map((r) => r.account?.name).join(', ')}
                </div>
              ) : (
                <p className="text-sm text-text-muted">No service runners connected</p>
              )}
            </div>

            {/* User Workers */}
            <div className="border border-border-default rounded-lg p-4">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <span className={`inline-flex items-center justify-center w-6 h-6 rounded-full ${runners.user.length > 0 ? 'bg-status-success/10 text-status-success' : 'bg-surface-3 text-text-muted'}`}>
                    {runners.user.length > 0 ? (
                      <svg viewBox="0 0 20 20" fill="currentColor" width="14" height="14">
                        <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                      </svg>
                    ) : (
                      <svg viewBox="0 0 20 20" fill="currentColor" width="14" height="14">
                        <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
                      </svg>
                    )}
                  </span>
                  <span className="font-medium">User Workers</span>
                  <span className={`px-2 py-0.5 text-xs rounded-full ${runners.user.length > 0 ? 'bg-primary/10 text-primary' : 'bg-surface-3 text-text-secondary'}`}>
                    {runners.user.length} connected
                  </span>
                </div>
              </div>
              {runners.user.length > 0 ? (
                <div className="text-sm text-text-muted">
                  {runners.user.map((r) => r.account?.name).join(', ')}
                </div>
              ) : (
                <p className="text-sm text-text-muted">No user workers connected</p>
              )}
            </div>
          </div>
        </div>

        {/* Connect Runner Section */}
        <ConnectRunnerSection workspaceId={workspace.id} workspaceName={workspace.name} />

        {/* Recent Tasks */}
        {workspace.tasks && workspace.tasks.length > 0 && (
          <div>
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-xl font-semibold">Recent Tasks</h2>
              <Link href={`/app/tasks?workspaceId=${workspace.id}`} className="text-sm text-primary hover:underline">
                View all
              </Link>
            </div>
            <div className="border border-border-default rounded-lg divide-y divide-border-default">
              {workspace.tasks.map((task) => (
                <Link
                  key={task.id}
                  href={`/app/tasks/${task.id}`}
                  className="block p-4 hover:bg-surface-3"
                >
                  <div className="flex justify-between items-start">
                    <div>
                      <h3 className="font-medium">{task.title}</h3>
                      <p className="text-sm text-text-muted line-clamp-1">{task.description}</p>
                    </div>
                    <span className={`px-2 py-1 text-xs rounded-full ${task.status === 'completed' ? 'bg-status-success/10 text-status-success' :
                      task.status === 'failed' ? 'bg-status-error/10 text-status-error' :
                        task.status === 'assigned' ? 'bg-primary/10 text-primary' :
                          'bg-status-warning/10 text-status-warning'
                      }`}>
                      {task.status}
                    </span>
                  </div>
                </Link>
              ))}
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
