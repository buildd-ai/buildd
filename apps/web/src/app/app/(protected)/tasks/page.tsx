import { db } from '@buildd/core/db';
import { tasks, workers, workspaces as workspacesTable, missions } from '@buildd/core/db/schema';
import { desc, eq, inArray, and, gte } from 'drizzle-orm';
import { deriveDisplayStatus, LIVE_WORKER_STATUSES } from '@/lib/task-timestamps';
import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { getCurrentUser } from '@/lib/auth-helpers';
import { resolveActiveTeamId, getTeamWorkspaceIds } from '@/lib/team-access';
import { displayWorkspaceName } from '@buildd/shared';
import TaskGrid from './TaskGrid';

export default async function TasksPage({
  searchParams,
}: {
  searchParams: Promise<{ mission?: string; workspace?: string }>;
}) {
  const { mission: missionId, workspace: wsFilter } = await searchParams;
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
    createdAt: string;
    updatedAt: string;
    workspaceName: string;
    prUrl: string | null;
    prNumber: number | null;
    summary: string | null;
    hasArtifact: boolean;
    filesChanged: number | null;
    waitingPrompt: string | null;
    missionId: string | null;
    missionTitle: string | null;
    budgetPaused: boolean;
    budgetBackend: string;
    budgetResetsAt: string | null;
    workerStatus: string | null;
    workerStartedAt: string | null;
    workerUpdatedAt: string | null;
  }> = [];

  let teamWorkspaces: { id: string; name: string }[] = [];

  if (!isDev && user) {
    try {
      const cookieStore = await cookies();
      const activeTeamId = await resolveActiveTeamId(user.id, cookieStore.get('buildd-team')?.value);

      if (activeTeamId) {
        const teamWsIds = await getTeamWorkspaceIds(activeTeamId);

        // Load team workspaces for filter dropdown + name lookup
        if (teamWsIds.length > 0) {
          teamWorkspaces = await db
            .select({ id: workspacesTable.id, name: workspacesTable.name })
            .from(workspacesTable)
            .where(inArray(workspacesTable.id, teamWsIds));
        }

        // Narrow to selected workspace if filter is set (must belong to team)
        const wsIds = (wsFilter && teamWsIds.includes(wsFilter)) ? [wsFilter] : teamWsIds;
        const wsNameMap = new Map(teamWorkspaces.map(w => [w.id, w.name]));

        if (wsIds.length > 0) {
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
              createdAt: true,
              updatedAt: true,
              workspaceId: true,
              result: true,
              missionId: true,
              context: true,
              backend: true,
            },
            orderBy: [desc(tasks.updatedAt)],
            limit: 200,
          });

          // Fetch mission titles for tasks that have missionId
          const missionIds = [...new Set(recentTasks.map(t => t.missionId).filter(Boolean))] as string[];
          const missionTitleMap = new Map<string, string>();
          if (missionIds.length > 0) {
            const misns = await db.query.missions.findMany({
              where: inArray(missions.id, missionIds),
              columns: { id: true, title: true },
            });
            for (const m of misns) {
              missionTitleMap.set(m.id, m.title);
            }
          }

          // Query active workers to enrich task status and timestamps
          const taskIds = recentTasks.map(t => t.id);
          const activeWorkers = taskIds.length > 0
            ? await db.query.workers.findMany({
                where: and(
                  inArray(workers.taskId, taskIds),
                  inArray(workers.status, [...LIVE_WORKER_STATUSES]),
                ),
                columns: {
                  taskId: true,
                  status: true,
                  waitingFor: true,
                  startedAt: true,
                  updatedAt: true,
                },
              })
            : [];
          const activeWorkerByTaskId = new Map<string, { status: string; waitingFor: unknown; startedAt: string | null; updatedAt: string | null }>();
          for (const w of activeWorkers) {
            if (w.taskId && !activeWorkerByTaskId.has(w.taskId)) {
              activeWorkerByTaskId.set(w.taskId, {
                status: w.status,
                waitingFor: w.waitingFor,
                startedAt: w.startedAt?.toISOString() ?? null,
                updatedAt: w.updatedAt?.toISOString() ?? null,
              });
            }
          }

          gridTasks = recentTasks.map(t => {
            const result = t.result as { summary?: string; prUrl?: string; prNumber?: number; files?: string[]; structuredOutput?: Record<string, unknown> } | null;
            const isTerminal = t.status === 'completed' || t.status === 'failed';
            const ctx = (t.context || {}) as Record<string, unknown>;
            const budgetPaused = t.status === 'pending' && ctx.budgetExhausted === true;
            const activeW = !isTerminal ? activeWorkerByTaskId.get(t.id) : undefined;
            const effectiveStatus = deriveDisplayStatus(t.status, activeW?.status);
            const waitingFor = activeW?.status === 'waiting_input' ? (activeW.waitingFor as { prompt?: string } | null) : null;
            return {
              id: t.id,
              title: t.title,
              status: effectiveStatus,
              category: t.category,
              createdAt: t.createdAt.toISOString(),
              updatedAt: t.updatedAt.toISOString(),
              workspaceName: displayWorkspaceName(wsNameMap.get(t.workspaceId) || 'Unknown'),
              prUrl: result?.prUrl || null,
              prNumber: result?.prNumber || null,
              summary: result?.summary || null,
              hasArtifact: !!result?.structuredOutput || (result?.files?.length ?? 0) > 0,
              filesChanged: result?.files?.length ?? null,
              waitingPrompt: waitingFor ? (waitingFor.prompt || 'Needs input') : null,
              missionId: t.missionId || null,
              missionTitle: t.missionId ? (missionTitleMap.get(t.missionId) || null) : null,
              budgetPaused,
              budgetBackend: t.backend === 'codex' ? 'Codex' : 'Claude',
              budgetResetsAt: budgetPaused ? ((ctx.budgetResetsAt as string | undefined) || null) : null,
              workerStatus: activeW?.status ?? null,
              workerStartedAt: activeW?.startedAt ?? null,
              workerUpdatedAt: activeW?.updatedAt ?? null,
            };
          });
        }
      }
    } catch (error) {
      console.error('Tasks grid query error:', error);
    }
  }

  // Look up mission title if filtered
  let missionTitle: string | null = null;
  if (missionId && user) {
    try {
      const mission = await db.query.missions.findFirst({
        where: eq(missions.id, missionId),
        columns: { title: true },
      });
      missionTitle = mission?.title || null;
    } catch {}
  }

  return (
    <TaskGrid
      tasks={gridTasks}
      missionFilter={missionId || null}
      missionTitle={missionTitle}
      workspaces={teamWorkspaces}
      selectedWorkspaceId={wsFilter ?? null}
    />
  );
}
