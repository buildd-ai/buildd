import { db } from '@buildd/core/db';
import { workspaces, tasks, accountWorkspaces } from '@buildd/core/db/schema';
import { eq, desc, and, count } from 'drizzle-orm';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { ConnectRunnerSection } from './connect-runner';
import DeleteWorkspaceButton from './DeleteWorkspaceButton';
import { getCurrentUser } from '@/lib/auth-helpers';

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
          <p className="text-gray-500">Development mode - no database</p>
        </div>
      </main>
    );
  }

  if (!user) {
    redirect('/app/auth/signin');
  }

  const workspace = await db.query.workspaces.findFirst({
    where: and(eq(workspaces.id, id), eq(workspaces.ownerId, user.id)),
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

  return (
    <main className="min-h-screen p-8">
      <div className="max-w-4xl mx-auto">
        <Link href="/app/workspaces" className="text-sm text-gray-500 hover:text-gray-700 mb-2 block">
          &larr; Workspaces
        </Link>

        <div className="flex justify-between items-start mb-8">
          <div>
            <h1 className="text-3xl font-bold">{workspace.name}</h1>
            {workspace.repo && (
              <p className="text-gray-500 mt-1">{workspace.repo}</p>
            )}
          </div>
          <div className="flex gap-2">
            <Link
              href={`/app/workspaces/${workspace.id}/config`}
              className="px-4 py-2 border border-gray-300 dark:border-gray-700 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-900"
            >
              ⚙️ Configure
            </Link>
            <DeleteWorkspaceButton workspaceId={workspace.id} workspaceName={workspace.name} />
            <Link
              href={`/app/tasks/new?workspaceId=${workspace.id}`}
              className="px-4 py-2 bg-black dark:bg-white text-white dark:text-black rounded-lg hover:opacity-80"
            >
              + New Task
            </Link>
          </div>
        </div>

        {/* Task Stats */}
        <div className="grid grid-cols-4 gap-4 mb-8">
          <div className="border border-gray-200 dark:border-gray-800 rounded-lg p-4">
            <div className="text-2xl font-bold">{taskCountMap['pending'] || 0}</div>
            <div className="text-sm text-gray-500">Pending</div>
          </div>
          <div className="border border-gray-200 dark:border-gray-800 rounded-lg p-4">
            <div className="text-2xl font-bold">{taskCountMap['assigned'] || 0}</div>
            <div className="text-sm text-gray-500">Assigned</div>
          </div>
          <div className="border border-gray-200 dark:border-gray-800 rounded-lg p-4">
            <div className="text-2xl font-bold">{taskCountMap['completed'] || 0}</div>
            <div className="text-sm text-gray-500">Completed</div>
          </div>
          <div className="border border-gray-200 dark:border-gray-800 rounded-lg p-4">
            <div className="text-2xl font-bold">{taskCountMap['failed'] || 0}</div>
            <div className="text-sm text-gray-500">Failed</div>
          </div>
        </div>

        {/* Connected Runners */}
        <div className="mb-8">
          <h2 className="text-xl font-semibold mb-4">Connected Runners</h2>

          <div className="space-y-4">
            {/* GitHub Actions */}
            <div className="border border-gray-200 dark:border-gray-800 rounded-lg p-4">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <span className={`inline-flex items-center justify-center w-6 h-6 rounded-full ${runners.action.length > 0 ? 'bg-green-100 text-green-600 dark:bg-green-900 dark:text-green-400' : 'bg-gray-100 text-gray-400 dark:bg-gray-800'}`}>
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
                  <span className={`px-2 py-0.5 text-xs rounded-full ${runners.action.length > 0 ? 'bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200' : 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400'}`}>
                    {runners.action.length} connected
                  </span>
                </div>
              </div>
              {runners.action.length > 0 ? (
                <div className="text-sm text-gray-500">
                  {runners.action.map((r) => r.account?.name).join(', ')}
                </div>
              ) : (
                <p className="text-sm text-gray-500">No GitHub Action runners connected yet</p>
              )}
            </div>

            {/* Service Workers */}
            <div className="border border-gray-200 dark:border-gray-800 rounded-lg p-4">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <span className={`inline-flex items-center justify-center w-6 h-6 rounded-full ${runners.service.length > 0 ? 'bg-green-100 text-green-600 dark:bg-green-900 dark:text-green-400' : 'bg-gray-100 text-gray-400 dark:bg-gray-800'}`}>
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
                  <span className={`px-2 py-0.5 text-xs rounded-full ${runners.service.length > 0 ? 'bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200' : 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400'}`}>
                    {runners.service.length} connected
                  </span>
                </div>
              </div>
              {runners.service.length > 0 ? (
                <div className="text-sm text-gray-500">
                  {runners.service.map((r) => r.account?.name).join(', ')}
                </div>
              ) : (
                <p className="text-sm text-gray-500">No service runners connected</p>
              )}
            </div>

            {/* User Workers */}
            <div className="border border-gray-200 dark:border-gray-800 rounded-lg p-4">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <span className={`inline-flex items-center justify-center w-6 h-6 rounded-full ${runners.user.length > 0 ? 'bg-green-100 text-green-600 dark:bg-green-900 dark:text-green-400' : 'bg-gray-100 text-gray-400 dark:bg-gray-800'}`}>
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
                  <span className={`px-2 py-0.5 text-xs rounded-full ${runners.user.length > 0 ? 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200' : 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400'}`}>
                    {runners.user.length} connected
                  </span>
                </div>
              </div>
              {runners.user.length > 0 ? (
                <div className="text-sm text-gray-500">
                  {runners.user.map((r) => r.account?.name).join(', ')}
                </div>
              ) : (
                <p className="text-sm text-gray-500">No user workers connected</p>
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
              <Link href={`/app/tasks?workspaceId=${workspace.id}`} className="text-sm text-blue-600 hover:underline">
                View all
              </Link>
            </div>
            <div className="border border-gray-200 dark:border-gray-800 rounded-lg divide-y divide-gray-200 dark:divide-gray-800">
              {workspace.tasks.map((task) => (
                <Link
                  key={task.id}
                  href={`/app/tasks/${task.id}`}
                  className="block p-4 hover:bg-gray-50 dark:hover:bg-gray-900"
                >
                  <div className="flex justify-between items-start">
                    <div>
                      <h3 className="font-medium">{task.title}</h3>
                      <p className="text-sm text-gray-500 line-clamp-1">{task.description}</p>
                    </div>
                    <span className={`px-2 py-1 text-xs rounded-full ${task.status === 'completed' ? 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200' :
                      task.status === 'failed' ? 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200' :
                        task.status === 'assigned' ? 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200' :
                          'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200'
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
