import { db } from '@buildd/core/db';
import { tasks, workspaces } from '@buildd/core/db/schema';
import { eq, inArray, desc } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth-helpers';
import WorkspaceSidebar from './WorkspaceSidebar';

export default async function TasksLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const isDev = process.env.NODE_ENV === 'development';
  const user = await getCurrentUser();

  if (!isDev && !user) {
    redirect('/app/auth/signin');
  }

  // Fetch workspaces and tasks for sidebar
  let workspacesWithTasks: Array<{
    id: string;
    name: string;
    tasks: Array<{
      id: string;
      title: string;
      status: string;
      updatedAt: Date;
    }>;
  }> = [];

  if (!isDev && user) {
    try {
      const userWorkspaces = await db.query.workspaces.findMany({
        where: eq(workspaces.ownerId, user.id),
        columns: { id: true, name: true },
        orderBy: desc(workspaces.updatedAt),
      });

      if (userWorkspaces.length > 0) {
        const workspaceIds = userWorkspaces.map(w => w.id);
        const allTasks = await db.query.tasks.findMany({
          where: inArray(tasks.workspaceId, workspaceIds),
          columns: {
            id: true,
            title: true,
            status: true,
            workspaceId: true,
            updatedAt: true,
            priority: true,
          },
          orderBy: [desc(tasks.priority), desc(tasks.updatedAt)],
        });

        // Group tasks by workspace
        type TaskSummary = { id: string; title: string; status: string; updatedAt: Date };
        const tasksByWorkspace = allTasks.reduce((acc, task) => {
          if (!acc[task.workspaceId]) acc[task.workspaceId] = [];
          acc[task.workspaceId].push({
            id: task.id,
            title: task.title,
            status: task.status,
            updatedAt: task.updatedAt,
          });
          return acc;
        }, {} as Record<string, TaskSummary[]>);

        workspacesWithTasks = userWorkspaces.map(ws => ({
          id: ws.id,
          name: ws.name,
          tasks: tasksByWorkspace[ws.id] || [],
        }));
      }
    } catch (error) {
      console.error('Tasks layout query error:', error);
    }
  }

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Sidebar */}
      <WorkspaceSidebar workspaces={workspacesWithTasks} />

      {/* Main content */}
      <main className="flex-1 overflow-auto">
        {children}
      </main>
    </div>
  );
}
