import { db } from '@buildd/core/db';
import { tasks, workers, workspaces, objectives } from '@buildd/core/db/schema';
import { desc, eq, inArray, and, gte } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth-helpers';
import { getUserWorkspaceIds } from '@/lib/team-access';
import TaskGrid from './TaskGrid';

export default async function TasksPage({
  searchParams,
}: {
  searchParams: Promise<{ mission?: string }>;
}) {
  const { mission: missionId } = await searchParams;
  const isDev = process.env.NODE_ENV === 'development';
  const user = await getCurrentUser();

  if (!isDev && !user) {
    redirect('/app/auth/signin');
  }

  let gridTasks: Array<{
    id: string;
    title: string;
    status: string;
    category: string | null;
    updatedAt: string;
    workspaceName: string;
    prUrl: string | null;
    prNumber: number | null;
    summary: string | null;
    hasArtifact: boolean;
    filesChanged: number | null;
    waitingPrompt: string | null;
    objectiveId: string | null;
    objectiveTitle: string | null;
  }> = [];

  if (!isDev && user) {
    try {
      const wsIds = await getUserWorkspaceIds(user.id);
      if (wsIds.length > 0) {
        // Fetch workspaces for name lookup
        const userWorkspaces = await db.query.workspaces.findMany({
          where: inArray(workspaces.id, wsIds),
          columns: { id: true, name: true },
        });
        const wsNameMap = new Map(userWorkspaces.map(w => [w.id, w.name]));

        // Fetch recent tasks (last 30 days, limit 200)
        const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
        const recentTasks = await db.query.tasks.findMany({
          where: and(
            inArray(tasks.workspaceId, wsIds),
            gte(tasks.updatedAt, thirtyDaysAgo),
          ),
          columns: {
            id: true,
            title: true,
            status: true,
            category: true,
            updatedAt: true,
            workspaceId: true,
            result: true,
            objectiveId: true,
          },
          orderBy: [desc(tasks.updatedAt)],
          limit: 200,
        });

        // Fetch objective titles for tasks that have objectiveId
        const objectiveIds = [...new Set(recentTasks.map(t => t.objectiveId).filter(Boolean))] as string[];
        const objectiveTitleMap = new Map<string, string>();
        if (objectiveIds.length > 0) {
          const objs = await db.query.objectives.findMany({
            where: inArray(objectives.id, objectiveIds),
            columns: { id: true, title: true },
          });
          for (const o of objs) {
            objectiveTitleMap.set(o.id, o.title);
          }
        }

        // Query workers waiting for input to enrich task status
        const waitingWorkers = await db.query.workers.findMany({
          where: eq(workers.status, 'waiting_input'),
          columns: { taskId: true, waitingFor: true },
        });
        const waitingByTaskId = new Map<string, string>();
        for (const w of waitingWorkers) {
          if (w.taskId && w.waitingFor) {
            const wf = w.waitingFor as { prompt?: string };
            waitingByTaskId.set(w.taskId, wf.prompt || 'Needs input');
          }
        }

        gridTasks = recentTasks.map(t => {
          const result = t.result as { summary?: string; prUrl?: string; prNumber?: number; files?: string[]; structuredOutput?: Record<string, unknown> } | null;
          const isTerminal = t.status === 'completed' || t.status === 'failed';
          const isWaiting = !isTerminal && waitingByTaskId.has(t.id);
          return {
            id: t.id,
            title: t.title,
            status: isWaiting ? 'waiting_input' : t.status,
            category: t.category,
            updatedAt: t.updatedAt.toISOString(),
            workspaceName: wsNameMap.get(t.workspaceId) || 'Unknown',
            prUrl: result?.prUrl || null,
            prNumber: result?.prNumber || null,
            summary: result?.summary || null,
            hasArtifact: !!result?.structuredOutput || (result?.files?.length ?? 0) > 0,
            filesChanged: result?.files?.length ?? null,
            waitingPrompt: isWaiting ? (waitingByTaskId.get(t.id) || null) : null,
            objectiveId: t.objectiveId || null,
            objectiveTitle: t.objectiveId ? (objectiveTitleMap.get(t.objectiveId) || null) : null,
          };
        });
      }
    } catch (error) {
      console.error('Tasks grid query error:', error);
    }
  }

  // Look up mission title if filtered
  let missionTitle: string | null = null;
  if (missionId && user) {
    try {
      const mission = await db.query.objectives.findFirst({
        where: eq(objectives.id, missionId),
        columns: { title: true },
      });
      missionTitle = mission?.title || null;
    } catch {}
  }

  return <TaskGrid tasks={gridTasks} missionFilter={missionId || null} missionTitle={missionTitle} />;
}
