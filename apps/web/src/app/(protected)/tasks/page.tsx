import { db } from '@buildd/core/db';
import { tasks, workspaces } from '@buildd/core/db/schema';
import { desc, eq, inArray } from 'drizzle-orm';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth-helpers';

export default async function TasksPage({
  searchParams,
}: {
  searchParams: Promise<{ hideCompleted?: string }>;
}) {
  const isDev = process.env.NODE_ENV === 'development';
  const user = await getCurrentUser();
  const params = await searchParams;
  const hideCompleted = params.hideCompleted === 'true';

  let allTasks: (typeof tasks.$inferSelect & {
    workspace: typeof workspaces.$inferSelect;
    subTasks?: { id: string }[];
    parentTask?: { id: string; title: string } | null;
  })[] = [];

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
          with: {
            workspace: true,
            subTasks: { columns: { id: true } },
            parentTask: { columns: { id: true, title: true } },
          },
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

  // Filter completed tasks if toggle is on
  const visibleTasks = hideCompleted
    ? allTasks.filter(t => !['completed', 'failed'].includes(t.status))
    : allTasks;

  // Smart sorting: active tasks first, then pending, then completed/failed
  const statusPriority: Record<string, number> = {
    running: 0,
    assigned: 1,
    pending: 2,
    completed: 3,
    failed: 4,
  };

  const sortedTasks = [...visibleTasks].sort((a, b) => {
    // First by status priority
    const statusDiff = (statusPriority[a.status] ?? 5) - (statusPriority[b.status] ?? 5);
    if (statusDiff !== 0) return statusDiff;
    // Then by priority (higher first)
    const priorityDiff = (b.priority ?? 0) - (a.priority ?? 0);
    if (priorityDiff !== 0) return priorityDiff;
    // Then by date (newer first)
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });

  // Group tasks by workspace
  const tasksByWorkspace = sortedTasks.reduce((acc, task) => {
    const wsId = task.workspaceId;
    if (!acc[wsId]) {
      acc[wsId] = { workspace: task.workspace, tasks: [] };
    }
    acc[wsId].tasks.push(task);
    return acc;
  }, {} as Record<string, { workspace: typeof workspaces.$inferSelect; tasks: typeof allTasks }>);

  // Sort workspace groups: those with active tasks first
  const sortedGroups = Object.values(tasksByWorkspace).sort((a, b) => {
    const aHasActive = a.tasks.some(t => t.status === 'running' || t.status === 'assigned');
    const bHasActive = b.tasks.some(t => t.status === 'running' || t.status === 'assigned');
    if (aHasActive && !bHasActive) return -1;
    if (!aHasActive && bHasActive) return 1;
    // Then by most recent task
    return new Date(b.tasks[0]?.createdAt || 0).getTime() - new Date(a.tasks[0]?.createdAt || 0).getTime();
  });

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
          <div className="flex items-center gap-4">
            <Link
              href={hideCompleted ? '/tasks' : '/tasks?hideCompleted=true'}
              className="text-sm text-gray-500 hover:text-gray-700"
            >
              {hideCompleted ? 'Show completed' : 'Hide completed'}
            </Link>
            <Link
              href="/tasks/new"
              className="px-4 py-2 bg-black dark:bg-white text-white dark:text-black rounded-lg hover:opacity-80"
            >
              + New Task
            </Link>
          </div>
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
          <div className="space-y-6">
            {sortedGroups.map(({ workspace, tasks: wsTasks }) => (
              <div key={workspace.id}>
                <div className="flex items-center gap-2 mb-2">
                  <h2 className="text-sm font-medium text-gray-500">{workspace.name}</h2>
                  <span className="text-xs text-gray-400">({wsTasks.length})</span>
                </div>
                <div className="border border-gray-200 dark:border-gray-800 rounded-lg divide-y divide-gray-200 dark:divide-gray-800">
                  {wsTasks.map((task) => (
                    <Link
                      key={task.id}
                      href={`/tasks/${task.id}`}
                      className="block p-4 hover:bg-gray-50 dark:hover:bg-gray-900"
                    >
                      <div className="flex justify-between items-start">
                        <div className="flex-1">
                          <div className="flex items-center gap-2">
                            <h3 className="font-medium">{task.title}</h3>
                            {task.subTasks && task.subTasks.length > 0 && (
                              <span className="text-xs text-gray-400">↳ {task.subTasks.length} subtask{task.subTasks.length !== 1 ? 's' : ''}</span>
                            )}
                            {task.parentTask && (
                              <span className="text-xs text-gray-400">← from #{task.parentTask.id.slice(0, 8)}</span>
                            )}
                          </div>
                          <p className="text-sm text-gray-500 line-clamp-1">{task.description}</p>
                        </div>
                        <span className={`px-2 py-1 text-xs rounded-full ml-4 ${statusColors[task.status] || statusColors.pending}`}>
                          {task.status}
                        </span>
                      </div>
                    </Link>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}
