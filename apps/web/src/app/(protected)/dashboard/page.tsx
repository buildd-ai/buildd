import { auth } from '@/auth';
import { db } from '@buildd/core/db';
import { workspaces, tasks, workers, githubInstallations } from '@buildd/core/db/schema';
import { desc, inArray } from 'drizzle-orm';
import Link from 'next/link';
import { isGitHubAppConfigured } from '@/lib/github';

export default async function DashboardPage() {
  const session = await auth();

  // In dev mode, show empty state
  const isDev = process.env.NODE_ENV === 'development';

  let userWorkspaces: typeof workspaces.$inferSelect[] = [];
  let recentTasks: (typeof tasks.$inferSelect & { workspace: typeof workspaces.$inferSelect })[] = [];
  let activeWorkers: (typeof workers.$inferSelect & { task: typeof tasks.$inferSelect })[] = [];
  let githubOrgs: { accountLogin: string; repoCount: number }[] = [];
  let githubConfigured = false;

  if (!isDev) {
    try {
      githubConfigured = isGitHubAppConfigured();

      // Get user's workspaces
      userWorkspaces = await db.query.workspaces.findMany({
        orderBy: desc(workspaces.createdAt),
        limit: 10,
      });

      const workspaceIds = userWorkspaces.map(w => w.id);

      if (workspaceIds.length > 0) {
        // Get recent tasks
        recentTasks = await db.query.tasks.findMany({
          where: inArray(tasks.workspaceId, workspaceIds),
          orderBy: desc(tasks.createdAt),
          limit: 10,
          with: { workspace: true },
        }) as any;

        // Get active workers
        activeWorkers = await db.query.workers.findMany({
          where: inArray(workers.status, ['running', 'starting', 'waiting_input']),
          orderBy: desc(workers.createdAt),
          limit: 10,
          with: { task: true },
        }) as any;
      }

      // Get GitHub installations
      if (githubConfigured) {
        const installations = await db.query.githubInstallations.findMany({
          with: { repos: true },
        });
        githubOrgs = installations.map(i => ({
          accountLogin: i.accountLogin,
          repoCount: i.repos?.length || 0,
        }));
      }
    } catch (error) {
      console.error('Dashboard query error:', error);
    }
  }

  return (
    <main className="min-h-screen p-8">
      <div className="max-w-6xl mx-auto">
        <div className="flex justify-between items-center mb-8">
          <div>
            <h1 className="text-3xl font-bold">buildd</h1>
            <p className="text-gray-600 dark:text-gray-400">
              {session?.user?.email || 'Development Mode'}
            </p>
          </div>
          <div className="flex items-center gap-4">
            <Link
              href="/accounts"
              className="px-4 py-2 text-sm border border-gray-300 dark:border-gray-700 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800"
            >
              Accounts
            </Link>
            <Link
              href="/api/auth/signout"
              className="px-4 py-2 text-sm text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
            >
              Sign Out
            </Link>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-4 gap-6 mb-8">
          {/* GitHub Card */}
          {githubConfigured ? (
            githubOrgs.length > 0 ? (
              <div className="p-6 border border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-950/30 rounded-lg">
                <div className="flex justify-between items-start mb-4">
                  <h2 className="text-xl font-semibold">GitHub</h2>
                  <span className="text-green-600">Connected</span>
                </div>
                <p className="text-gray-600 dark:text-gray-400 text-sm">
                  {githubOrgs.map(o => o.accountLogin).join(', ')}
                </p>
                <p className="text-xs text-gray-500 mt-1">
                  {githubOrgs.reduce((sum, o) => sum + o.repoCount, 0)} repos
                </p>
              </div>
            ) : (
              <a
                href="/api/github/install"
                className="block p-6 border border-dashed border-gray-300 dark:border-gray-700 rounded-lg hover:border-blue-400 dark:hover:border-blue-600 transition-colors"
              >
                <div className="flex justify-between items-start mb-4">
                  <h2 className="text-xl font-semibold">GitHub</h2>
                  <span className="text-blue-600">+ Connect</span>
                </div>
                <p className="text-gray-600 dark:text-gray-400 text-sm">
                  Connect your org to auto-discover repos
                </p>
              </a>
            )
          ) : (
            <div className="p-6 border border-gray-200 dark:border-gray-800 rounded-lg opacity-50">
              <div className="flex justify-between items-start mb-4">
                <h2 className="text-xl font-semibold">GitHub</h2>
                <span className="text-gray-400">Not configured</span>
              </div>
              <p className="text-gray-500 text-sm">
                GitHub App not set up
              </p>
            </div>
          )}

          {/* Workspaces Card */}
          <Link
            href="/workspaces"
            className="block p-6 border border-gray-200 dark:border-gray-800 rounded-lg hover:border-gray-400 dark:hover:border-gray-600 transition-colors"
          >
            <div className="flex justify-between items-start mb-4">
              <h2 className="text-xl font-semibold">Workspaces</h2>
              <span className="text-2xl font-bold">{userWorkspaces.length}</span>
            </div>
            <p className="text-gray-600 dark:text-gray-400 text-sm">
              GitHub repos connected for task execution
            </p>
          </Link>

          {/* Tasks Card */}
          <Link
            href="/tasks"
            className="block p-6 border border-gray-200 dark:border-gray-800 rounded-lg hover:border-gray-400 dark:hover:border-gray-600 transition-colors"
          >
            <div className="flex justify-between items-start mb-4">
              <h2 className="text-xl font-semibold">Tasks</h2>
              <span className="text-2xl font-bold">{recentTasks.length}</span>
            </div>
            <p className="text-gray-600 dark:text-gray-400 text-sm">
              Work items for agents to complete
            </p>
          </Link>

          {/* Workers Card */}
          <Link
            href="/workers"
            className="block p-6 border border-gray-200 dark:border-gray-800 rounded-lg hover:border-gray-400 dark:hover:border-gray-600 transition-colors"
          >
            <div className="flex justify-between items-start mb-4">
              <h2 className="text-xl font-semibold">Workers</h2>
              <span className="text-2xl font-bold text-green-600">{activeWorkers.length}</span>
            </div>
            <p className="text-gray-600 dark:text-gray-400 text-sm">
              Active agents working on tasks
            </p>
          </Link>
        </div>

        {/* Recent Tasks */}
        <div className="mb-8">
          <div className="flex justify-between items-center mb-4">
            <h2 className="text-xl font-semibold">Recent Tasks</h2>
            <Link
              href="/tasks/new"
              className="px-4 py-2 bg-black dark:bg-white text-white dark:text-black rounded-lg hover:opacity-80 text-sm"
            >
              + New Task
            </Link>
          </div>

          {recentTasks.length === 0 ? (
            <div className="border border-dashed border-gray-300 dark:border-gray-700 rounded-lg p-8 text-center">
              <p className="text-gray-500 mb-4">No tasks yet</p>
              <Link
                href="/tasks/new"
                className="text-blue-600 hover:underline"
              >
                Create your first task
              </Link>
            </div>
          ) : (
            <div className="border border-gray-200 dark:border-gray-800 rounded-lg divide-y divide-gray-200 dark:divide-gray-800">
              {recentTasks.map((task) => (
                <Link
                  key={task.id}
                  href={`/tasks/${task.id}`}
                  className="block p-4 hover:bg-gray-50 dark:hover:bg-gray-900"
                >
                  <div className="flex justify-between items-start">
                    <div>
                      <h3 className="font-medium">{task.title}</h3>
                      <p className="text-sm text-gray-500">{task.workspace?.name}</p>
                    </div>
                    <StatusBadge status={task.status} />
                  </div>
                </Link>
              ))}
            </div>
          )}
        </div>

        {/* Active Workers */}
        <div>
          <h2 className="text-xl font-semibold mb-4">Active Workers</h2>

          {activeWorkers.length === 0 ? (
            <div className="border border-dashed border-gray-300 dark:border-gray-700 rounded-lg p-8 text-center">
              <p className="text-gray-500">No active workers</p>
              <p className="text-sm text-gray-400 mt-2">
                Workers will appear here when agents claim tasks
              </p>
            </div>
          ) : (
            <div className="border border-gray-200 dark:border-gray-800 rounded-lg divide-y divide-gray-200 dark:divide-gray-800">
              {activeWorkers.map((worker) => (
                <div
                  key={worker.id}
                  className="p-4 hover:bg-gray-50 dark:hover:bg-gray-900"
                >
                  <div className="flex justify-between items-start">
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <h3 className="font-medium">{worker.name}</h3>
                        <StatusBadge status={worker.status} />
                      </div>
                      <p className="text-sm text-gray-500">{worker.task?.title}</p>
                      {worker.currentAction && (
                        <p className="text-xs text-gray-400 mt-1">{worker.currentAction}</p>
                      )}
                      {/* Milestone progress */}
                      {worker.milestones && (worker.milestones as any[]).length > 0 && (
                        <div className="flex items-center gap-1 mt-2">
                          {Array.from({ length: Math.min((worker.milestones as any[]).length, 10) }).map((_, i) => (
                            <div
                              key={i}
                              className="w-6 h-2 bg-blue-500 rounded-sm"
                            />
                          ))}
                          {Array.from({ length: Math.max(0, 10 - (worker.milestones as any[]).length) }).map((_, i) => (
                            <div
                              key={i}
                              className="w-6 h-2 bg-gray-200 dark:bg-gray-700 rounded-sm"
                            />
                          ))}
                          <span className="text-xs text-gray-500 ml-2">
                            {(worker.milestones as any[]).length}
                          </span>
                        </div>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      {/* PR link */}
                      {worker.prUrl && (
                        <a
                          href={worker.prUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="px-3 py-1 text-xs bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200 rounded-full hover:bg-green-200 dark:hover:bg-green-800"
                        >
                          PR #{worker.prNumber}
                        </a>
                      )}
                      {/* Jump to local-ui link */}
                      {worker.localUiUrl && (
                        <a
                          href={`${worker.localUiUrl}/worker/${worker.id}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="px-3 py-1 text-xs bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200 rounded-full hover:bg-blue-200 dark:hover:bg-blue-800"
                        >
                          Open Terminal
                        </a>
                      )}
                      <Link
                        href={`/workers/${worker.id}`}
                        className="px-3 py-1 text-xs border border-gray-300 dark:border-gray-600 rounded-full hover:bg-gray-100 dark:hover:bg-gray-800"
                      >
                        Details
                      </Link>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </main>
  );
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    pending: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200',
    assigned: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200',
    running: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200',
    starting: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200',
    completed: 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200',
    failed: 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200',
    waiting_input: 'bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200',
  };

  return (
    <span className={`px-2 py-1 text-xs rounded-full ${colors[status] || colors.pending}`}>
      {status}
    </span>
  );
}
