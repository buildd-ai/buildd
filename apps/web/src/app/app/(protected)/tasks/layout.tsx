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
    gitConfig?: { targetBranch?: string; defaultBranch?: string } | null;
    tasks: Array<{
      id: string;
      title: string;
      description?: string | null;
      status: string;
      category?: string | null;
      dependsOn?: string[];
      updatedAt: Date;
      waitingFor?: { type: string; prompt: string; options?: string[] } | null;
      objectiveId?: string | null;
      resultSummary?: string | null;
      prUrl?: string | null;
      prNumber?: number | null;
      hasArtifact?: boolean;
    }>;
  }> = [];


  if (!isDev && user) {
    try {
      const wsIds = await getUserWorkspaceIds(user.id);
      const userWorkspaces = wsIds.length > 0 ? await db.query.workspaces.findMany({
        where: inArray(workspaces.id, wsIds),
        columns: { id: true, name: true, gitConfig: true },
        orderBy: desc(workspaces.updatedAt),
      }) : [];

      if (userWorkspaces.length > 0) {
        const workspaceIds = userWorkspaces.map(w => w.id);
        const allTasks = await db.query.tasks.findMany({
          where: inArray(tasks.workspaceId, workspaceIds),
          columns: {
            id: true,
            title: true,
            description: true,
            status: true,
            category: true,
            dependsOn: true,
            workspaceId: true,
            updatedAt: true,
            priority: true,
            objectiveId: true,
            result: true,
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
        type TaskSummary = { id: string; title: string; description?: string | null; status: string; category?: string | null; dependsOn?: string[]; updatedAt: Date; waitingFor?: { type: string; prompt: string; options?: string[] } | null; objectiveId?: string | null; resultSummary?: string | null; prUrl?: string | null; prNumber?: number | null; hasArtifact?: boolean };
        const tasksByWorkspace = allTasks.reduce((acc, task) => {
          if (!acc[task.workspaceId]) acc[task.workspaceId] = [];
          // Only override status with waiting_input if the task isn't already completed/failed
          const isTerminal = task.status === 'completed' || task.status === 'failed';
          const taskResult = task.result as { summary?: string; prUrl?: string; prNumber?: number; structuredOutput?: Record<string, unknown>; files?: string[] } | null;
          acc[task.workspaceId].push({
            id: task.id,
            title: task.title,
            description: task.description || null,
            status: !isTerminal && waitingForByTaskId.has(task.id) ? 'waiting_input' : task.status,
            category: task.category,
            dependsOn: (task.dependsOn as string[]) || [],
            updatedAt: task.updatedAt,
            waitingFor: !isTerminal ? (waitingForByTaskId.get(task.id) || null) : null,
            objectiveId: task.objectiveId,
            resultSummary: taskResult?.summary || null,
            prUrl: taskResult?.prUrl || null,
            prNumber: taskResult?.prNumber || null,
            hasArtifact: !!taskResult?.structuredOutput || (taskResult?.files?.length ?? 0) > 0,
          });
          return acc;
        }, {} as Record<string, TaskSummary[]>);

        workspacesWithTasks = userWorkspaces.map(ws => ({
          id: ws.id,
          name: ws.name,
          gitConfig: ws.gitConfig ? {
            targetBranch: ws.gitConfig.targetBranch,
            defaultBranch: ws.gitConfig.defaultBranch,
          } : null,
          tasks: tasksByWorkspace[ws.id] || [],
        }));
      }

    } catch (error) {
      console.error('Tasks layout query error:', error);
    }
  }

  return (
    <MobileTasksLayout
      sidebar={<WorkspaceSidebar workspaces={workspacesWithTasks} />}
      workspaces={workspacesWithTasks.map(w => ({ id: w.id, name: w.name }))}
    >
      {children}
    </MobileTasksLayout>
  );
}
