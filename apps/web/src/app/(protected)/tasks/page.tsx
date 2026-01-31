import { db } from '@buildd/core/db';
import { tasks, workspaces } from '@buildd/core/db/schema';
import { desc, eq, inArray } from 'drizzle-orm';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth-helpers';

export default async function TasksPage() {
  const isDev = process.env.NODE_ENV === 'development';
  const user = await getCurrentUser();

  let allTasks: (typeof tasks.$inferSelect & { workspace: typeof workspaces.$inferSelect })[] = [];

  if (!isDev) {
    if (!user) {
      redirect('/auth/signin');
    }

    try {
      // Get user's workspace IDs first
      const userWorkspaces = await db.query.workspaces.findMany({
        where: eq(workspaces.ownerId, user.id),
        columns: { id: true },
      });
      const workspaceIds = userWorkspaces.map(w => w.id);

      if (workspaceIds.length > 0) {
        allTasks = await db.query.tasks.findMany({
          where: inArray(tasks.workspaceId, workspaceIds),
          orderBy: desc(tasks.createdAt),
          with: { workspace: true },
        }) as any;
      }
    } catch (error) {
      console.error('Tasks query error:', error);
    }
  }

  const statusColors: Record<string, string> = {
    pending: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200',
    assigned: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200',
    running: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200',
    completed: 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200',
    failed: 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200',
  };

  return (
    <main className="min-h-screen p-8">
      <div className="max-w-4xl mx-auto">
        <div className="flex justify-between items-center mb-8">
          <div>
            <Link href="/dashboard" className="text-sm text-gray-500 hover:text-gray-700 mb-2 block">
              ← Dashboard
            </Link>
            <h1 className="text-3xl font-bold">Tasks</h1>
          </div>
          <Link
            href="/tasks/new"
            className="px-4 py-2 bg-black dark:bg-white text-white dark:text-black rounded-lg hover:opacity-80"
          >
            + New Task
          </Link>
        </div>

        {allTasks.length === 0 ? (
          <div className="border border-dashed border-gray-300 dark:border-gray-700 rounded-lg p-12 text-center">
            <h2 className="text-xl font-semibold mb-2">No tasks yet</h2>
            <p className="text-gray-500 mb-6">
              Create a task for agents to work on
            </p>
            <Link
              href="/tasks/new"
              className="px-6 py-3 bg-black dark:bg-white text-white dark:text-black rounded-lg hover:opacity-80"
            >
              Create Task
            </Link>
          </div>
        ) : (
          <div className="border border-gray-200 dark:border-gray-800 rounded-lg divide-y divide-gray-200 dark:divide-gray-800">
            {allTasks.map((task) => (
              <Link
                key={task.id}
                href={`/tasks/${task.id}`}
                className="block p-4 hover:bg-gray-50 dark:hover:bg-gray-900"
              >
                <div className="flex justify-between items-start">
                  <div className="flex-1">
                    <h3 className="font-medium">{task.title}</h3>
                    <p className="text-sm text-gray-500 line-clamp-1">{task.description}</p>
                    <p className="text-xs text-gray-400 mt-1">{task.workspace?.name}</p>
                  </div>
                  <span className={`px-2 py-1 text-xs rounded-full ml-4 ${statusColors[task.status] || statusColors.pending}`}>
                    {task.status}
                  </span>
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}
