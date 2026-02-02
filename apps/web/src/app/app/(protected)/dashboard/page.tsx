import { db } from '@buildd/core/db';
import { workspaces, tasks, workers, githubInstallations } from '@buildd/core/db/schema';
import { desc, inArray, eq, and } from 'drizzle-orm';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { isGitHubAppConfigured } from '@/lib/github';
import { getCurrentUser } from '@/lib/auth-helpers';

export default async function DashboardPage() {
  const user = await getCurrentUser();

  // In dev mode, show empty state
  const isDev = process.env.NODE_ENV === 'development';

  let userWorkspaces: typeof workspaces.$inferSelect[] = [];
  let recentTasks: (typeof tasks.$inferSelect & { workspace: typeof workspaces.$inferSelect })[] = [];
  let activeWorkers: (typeof workers.$inferSelect & { task: typeof tasks.$inferSelect })[] = [];
  let githubOrgs: { accountLogin: string; repoCount: number }[] = [];
  let githubConfigured = false;

  if (!isDev) {
    if (!user) {
      redirect('/app/auth/signin');
    }

    try {
      githubConfigured = isGitHubAppConfigured();

      // Get user's workspaces (filtered by owner)
      userWorkspaces = await db.query.workspaces.findMany({
        where: eq(workspaces.ownerId, user.id),
        orderBy: desc(workspaces.createdAt),
        limit: 10,
      });

      const workspaceIds = userWorkspaces.map(w => w.id);

      if (workspaceIds.length > 0) {
        // Get recent tasks (from user's workspaces)
        recentTasks = await db.query.tasks.findMany({
          where: inArray(tasks.workspaceId, workspaceIds),
          orderBy: desc(tasks.createdAt),
          limit: 10,
          with: { workspace: true },
        }) as any;

        // Get active workers (from user's workspaces)
        activeWorkers = await db.query.workers.findMany({
          where: and(
            inArray(workers.workspaceId, workspaceIds),
            inArray(workers.status, ['running', 'starting', 'waiting_input'])
          ),
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
              {user?.email || 'Development Mode'}
            </p>
          </div>
          <div className="flex items-center gap-4">
            {/* GitHub Status in Header */}
            {githubConfigured && (
              githubOrgs.length > 0 ? (
                <Link
                  href="/app/settings"
                  className="flex items-center gap-2 px-3 py-1.5 text-sm bg-green-50 dark:bg-green-950/30 border border-green-200 dark:border-green-800 rounded-lg hover:bg-green-100 dark:hover:bg-green-900/30"
                >
                  <svg className="w-4 h-4 text-green-600" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/>
                  </svg>
                  <span className="text-green-700 dark:text-green-400">
                    {githubOrgs.length === 1 ? githubOrgs[0].accountLogin : `${githubOrgs.length} orgs`}
                  </span>
                </Link>
              ) : (
                <a
                  href="/api/github/install"
                  className="flex items-center gap-2 px-3 py-1.5 text-sm border border-dashed border-gray-300 dark:border-gray-600 rounded-lg hover:border-blue-400 dark:hover:border-blue-500 hover:bg-blue-50 dark:hover:bg-blue-950/30"
                >
                  <svg className="w-4 h-4 text-gray-500" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/>
                  </svg>
                  <span className="text-blue-600 dark:text-blue-400">Connect GitHub</span>
                </a>
              )
            )}
            <Link
              href="/app/settings"
              className="px-4 py-2 text-sm border border-gray-300 dark:border-gray-700 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800"
            >
              Settings
            </Link>
            <Link
              href="/app/accounts"
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

        {/* Setup Banner - shows when GitHub not connected */}
        {githubConfigured && githubOrgs.length === 0 && (
          <div className="mb-6 p-4 bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 rounded-lg">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-blue-100 dark:bg-blue-900 rounded-lg">
                  <svg className="w-5 h-5 text-blue-600 dark:text-blue-400" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/>
                  </svg>
                </div>
                <div>
                  <h3 className="font-medium text-blue-900 dark:text-blue-100">Connect GitHub to get started</h3>
                  <p className="text-sm text-blue-700 dark:text-blue-300">Link your GitHub org to auto-discover repos for workspaces</p>
                </div>
              </div>
              <a
                href="/api/github/install"
                className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-medium"
              >
                Connect GitHub
              </a>
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
          {/* Workspaces Card */}
          <Link
            href="/app/workspaces"
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
            href="/app/tasks"
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
            href="/app/workers"
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
              href="/app/tasks/new"
              className="px-4 py-2 bg-black dark:bg-white text-white dark:text-black rounded-lg hover:opacity-80 text-sm"
            >
              + New Task
            </Link>
          </div>

          {recentTasks.length === 0 ? (
            <div className="border border-dashed border-gray-300 dark:border-gray-700 rounded-lg p-8 text-center">
              <p className="text-gray-500 mb-4">No tasks yet</p>
              <Link
                href="/app/tasks/new"
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
                  href={`/app/tasks/${task.id}`}
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
                        href={`/app/workers/${worker.id}`}
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
