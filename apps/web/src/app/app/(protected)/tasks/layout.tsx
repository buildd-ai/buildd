import { db } from '@buildd/core/db';
import { tasks, workers, workspaces } from '@buildd/core/db/schema';
import { eq, inArray, desc } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth-helpers';
import { getUserWorkspaceIds } from '@/lib/team-access';
import WorkspaceSidebar from './WorkspaceSidebar';
import MobileTasksLayout from './MobileTasksLayout';

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
      waitingFor?: { type: string; prompt: string; options?: string[] } | null;
    }>;
  }> = [];

  if (!isDev && user) {
    try {
      const wsIds = await getUserWorkspaceIds(user.id);
      const userWorkspaces = wsIds.length > 0 ? await db.query.workspaces.findMany({
        where: inArray(workspaces.id, wsIds),
        columns: { id: true, name: true },
        orderBy: desc(workspaces.updatedAt),
      }) : [];

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

        // Query workers with waiting_input status to get waitingFor data
        const waitingWorkers = await db.query.workers.findMany({
          where: eq(workers.status, 'waiting_input'),
          columns: { taskId: true, waitingFor: true },
        });
        const waitingForByTaskId = new Map<string, { type: string; prompt: string; options?: string[] } | null>();
        for (const w of waitingWorkers) {
          if (w.taskId && w.waitingFor) {
            waitingForByTaskId.set(w.taskId, w.waitingFor as any);
          }
        }

        // Group tasks by workspace
        type TaskSummary = { id: string; title: string; status: string; updatedAt: Date; waitingFor?: { type: string; prompt: string; options?: string[] } | null };
        const tasksByWorkspace = allTasks.reduce((acc, task) => {
          if (!acc[task.workspaceId]) acc[task.workspaceId] = [];
          // Only override status with waiting_input if the task isn't already completed/failed
          const isTerminal = task.status === 'completed' || task.status === 'failed';
          acc[task.workspaceId].push({
            id: task.id,
            title: task.title,
            status: !isTerminal && waitingForByTaskId.has(task.id) ? 'waiting_input' : task.status,
            updatedAt: task.updatedAt,
            waitingFor: !isTerminal ? (waitingForByTaskId.get(task.id) || null) : null,
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
    <MobileTasksLayout sidebar={<WorkspaceSidebar workspaces={workspacesWithTasks} />}>
      {children}
    </MobileTasksLayout>
  );
}
