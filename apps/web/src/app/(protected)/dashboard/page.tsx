import { auth } from '@/auth';
import { db } from '@buildd/core/db';
import { workspaces, tasks, workers } from '@buildd/core/db/schema';
import { desc, eq, inArray } from 'drizzle-orm';
import Link from 'next/link';

export default async function DashboardPage() {
  const session = await auth();

  // In dev mode, show empty state
  const isDev = process.env.NODE_ENV === 'development';

  let userWorkspaces: typeof workspaces.$inferSelect[] = [];
  let recentTasks: (typeof tasks.$inferSelect & { workspace: typeof workspaces.$inferSelect })[] = [];
  let activeWorkers: (typeof workers.$inferSelect & { task: typeof tasks.$inferSelect })[] = [];

  if (!isDev) {
    try {
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
          <Link
            href="/api/auth/signout"
            className="px-4 py-2 text-sm border border-gray-300 dark:border-gray-700 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800"
          >
            Sign Out
          </Link>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
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
                <Link
                  key={worker.id}
                  href={`/workers/${worker.id}`}
                  className="block p-4 hover:bg-gray-50 dark:hover:bg-gray-900"
                >
                  <div className="flex justify-between items-start">
                    <div>
                      <h3 className="font-medium">{worker.name}</h3>
                      <p className="text-sm text-gray-500">{worker.task?.title}</p>
                    </div>
                    <StatusBadge status={worker.status} />
                  </div>
                </Link>
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
