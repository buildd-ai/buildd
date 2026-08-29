import { db } from '@buildd/core/db';
import { tasks, workers, workspaces as workspacesTable, missions, initiatives } from '@buildd/core/db/schema';
import { desc, eq, inArray, and, gte, isNull } from 'drizzle-orm';
import { deriveTaskType, type TaskType } from '@buildd/core/mission-helpers';
import { deriveDisplayStatus, LIVE_WORKER_STATUSES, deriveChainPosition } from '@/lib/task-presentation';
import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { getCurrentUser } from '@/lib/auth-helpers';
import { resolveActiveTeamId, getTeamWorkspaceIds } from '@/lib/team-access';
import { displayWorkspaceName } from '@buildd/shared';
import type { ChainPositionResult, ChainPositionDep } from '@/lib/task-presentation';
import TaskGrid from './TaskGrid';
import { backendLabel } from '@buildd/core/backend-policy';

export default async function TasksPage({
  searchParams,
}: {
  searchParams: Promise<{ mission?: string; workspace?: string; initiative?: string }>;
}) {
  const { mission: missionId, workspace: wsFilter, initiative: initiativeId } = await searchParams;
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
    prLifecycleStatus: string | null;
    summary: string | null;
    hasArtifact: boolean;
    filesChanged: number | null;
    waitingPrompt: string | null;
    missionId: string | null;
    missionTitle: string | null;
    budgetPaused: boolean;
    budgetBackend: string;
    budgetResetsAt: string | null;
    startAt: string | null;
    loopIteration: number | null;
    loopState: 'running' | 'condition_unmet' | 'exhausted' | 'satisfied' | null;
    loopMaxLoops: number | null;
    workerStatus: string | null;
    workerStartedAt: string | null;
    workerUpdatedAt: string | null;
    runnerName: string | null;
    chain: ChainPositionResult | null;
    attemptCurrent: number | null;
    attemptTotal: number | null;
    taskType: TaskType | null;
    parentTaskId: string | null;
    taskClass: string | null;
    loopExitConditionType: string | null;
  }> = [];

  let teamWorkspaces: { id: string; name: string }[] = [];
  let initiativeTitle: string | null = null;
  let initiativeMissionIds: string[] = [];

  if (!isDev && user) {
    try {
      const cookieStore = await cookies();
      const activeTeamId = await resolveActiveTeamId(user.id, cookieStore.get('buildd-team')?.value);

      if (activeTeamId) {
        // Resolve initiative title early (independent of workspace/task queries)
        if (initiativeId) {
          try {
            const init = await db.query.initiatives.findFirst({
              where: eq(initiatives.id, initiativeId),
              columns: { title: true },
            });
            initiativeTitle = init?.title || null;
          } catch {}
        }

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
              isNull(tasks.parentTaskId),
            ),
            columns: {
              id: true,
              title: true,
              status: true,
              mode: true,
              category: true,
              createdAt: true,
              updatedAt: true,
              workspaceId: true,
              result: true,
              missionId: true,
              context: true,
              backend: true,
              dependsOn: true,
              startAt: true,
              loopConfig: true,
              loopIteration: true,
              loopState: true,
              parentTaskId: true,
              taskClass: true,
            },
            orderBy: [desc(tasks.updatedAt)],
            limit: 200,
          });

          // Fetch child tasks (retry/reviewer) for the root tasks we loaded
          const rootIds = recentTasks.map(t => t.id);
          const childTasks = rootIds.length > 0
            ? await db.query.tasks.findMany({
                where: inArray(tasks.parentTaskId, rootIds),
                columns: {
                  id: true,
                  title: true,
                  status: true,
                  mode: true,
                  category: true,
                  createdAt: true,
                  updatedAt: true,
                  workspaceId: true,
                  result: true,
                  missionId: true,
                  context: true,
                  backend: true,
                  dependsOn: true,
                  startAt: true,
                  loopConfig: true,
                  loopIteration: true,
                  loopState: true,
                  parentTaskId: true,
                  taskClass: true,
                },
                limit: 500,
              })
            : [];
          const allTasks = [...recentTasks, ...childTasks];

          // Fetch mission titles for tasks that have missionId
          const missionIds = [...new Set(allTasks.map(t => t.missionId).filter(Boolean))] as string[];
          const missionTitleMap = new Map<string, string>();
          if (missionIds.length > 0) {
            const misns = await db.query.missions.findMany({
              where: inArray(missions.id, missionIds),
              columns: { id: true, title: true, initiativeId: true },
            });
            for (const m of misns) {
              missionTitleMap.set(m.id, m.title);
              if (initiativeId && m.initiativeId === initiativeId) {
                initiativeMissionIds.push(m.id);
              }
            }
          }

          // Query active workers to enrich task status and timestamps
          const taskIds = allTasks.map(t => t.id);
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
                  name: true,
                },
              })
            : [];
          const activeWorkerByTaskId = new Map<string, { status: string; waitingFor: unknown; startedAt: string | null; updatedAt: string | null; name: string }>();
          for (const w of activeWorkers) {
            if (w.taskId && !activeWorkerByTaskId.has(w.taskId)) {
              activeWorkerByTaskId.set(w.taskId, {
                status: w.status,
                waitingFor: w.waitingFor,
                startedAt: w.startedAt?.toISOString() ?? null,
                updatedAt: w.updatedAt?.toISOString() ?? null,
                name: w.name,
              });
            }
          }

          // Fetch prLifecycleStatus for completed tasks that have a prUrl (to distinguish merged vs open PRs)
          const completedPrTaskIds = allTasks
            .filter(t => t.status === 'completed' && (t.result as { prUrl?: string } | null)?.prUrl)
            .map(t => t.id);
          const prLifecycleByTaskId = new Map<string, string | null>();
          if (completedPrTaskIds.length > 0) {
            const lastWorkers = await db.query.workers.findMany({
              where: inArray(workers.taskId, completedPrTaskIds),
              columns: { taskId: true, prLifecycleStatus: true },
              orderBy: [desc(workers.startedAt)],
            });
            for (const w of lastWorkers) {
              if (w.taskId && !prLifecycleByTaskId.has(w.taskId)) {
                prLifecycleByTaskId.set(w.taskId, w.prLifecycleStatus ?? null);
              }
            }
          }

          // Chain data — only for non-terminal tasks (completed rows don't need it)
          const nonTerminalTaskIds = allTasks
            .filter(t => !['completed', 'failed', 'cancelled'].includes(t.status))
            .map(t => t.id);
          const allDepIds = [...new Set(
            allTasks
              .filter(t => nonTerminalTaskIds.includes(t.id))
              .flatMap(t => (t.dependsOn as string[] | null) ?? [])
          )];
          const depInfoMap = new Map<string, ChainPositionDep>();
          if (allDepIds.length > 0) {
            const depTasks = await db.query.tasks.findMany({
              where: inArray(tasks.id, allDepIds),
              // title → readable rail chips; dependsOn → transitive reduction of
              // the blocker set (deps are often not in the loaded page window).
              columns: { id: true, title: true, status: true, dependsOn: true },
              with: {
                workers: {
                  // No limit: the gate asks "does ANY worker hold an open PR?",
                  // matching dependenciesSatisfied() in the claim route. Reading
                  // only the latest worker missed an older open PR.
                  // prLifecycleStatus: a closed/abandoned PR unblocks dependents.
                  columns: { prUrl: true, prNumber: true, mergedAt: true, prLifecycleStatus: true },
                  orderBy: (w: any, { desc: d }: any) => [d(w.startedAt)],
                },
              },
            });
            for (const dt of depTasks) {
              depInfoMap.set(dt.id, {
                id: dt.id,
                title: dt.title,
                status: dt.status,
                dependsOn: (dt.dependsOn as string[] | null) ?? [],
                workers: dt.workers.map((w: any) => ({
                  prUrl: w.prUrl ?? null,
                  prNumber: w.prNumber ?? null,
                  mergedAt: w.mergedAt ? String(w.mergedAt) : null,
                  prLifecycleStatus: w.prLifecycleStatus ?? null,
                })),
              });
            }
          }
          // Count dependents within the loaded set
          const dependentCount = new Map<string, number>();
          for (const t of allTasks) {
            if (nonTerminalTaskIds.includes(t.id)) {
              for (const depId of (t.dependsOn as string[] | null) ?? []) {
                dependentCount.set(depId, (dependentCount.get(depId) ?? 0) + 1);
              }
            }
          }
          gridTasks = allTasks.map(t => {
            const result = t.result as { summary?: string; prUrl?: string; prNumber?: number; files?: string[]; structuredOutput?: Record<string, unknown> } | null;
            const isTerminal = t.status === 'completed' || t.status === 'failed';
            const ctx = (t.context || {}) as Record<string, unknown>;
            const budgetPaused = t.status === 'pending' && ctx.budgetExhausted === true;
            const activeW = !isTerminal ? activeWorkerByTaskId.get(t.id) : undefined;
            const effectiveStatus = deriveDisplayStatus(t.status, activeW?.status);
            const waitingFor = activeW?.status === 'waiting_input' ? (activeW.waitingFor as { prompt?: string } | null) : null;

            // Chain: only for non-terminal tasks
            let chain: ChainPositionResult | null = null;
            if (!isTerminal) {
              const depIds = (t.dependsOn as string[] | null) ?? [];
              if (depIds.length > 0) {
                const deps = depIds
                  .map(id => depInfoMap.get(id))
                  .filter(Boolean) as ChainPositionDep[];
                chain = deriveChainPosition({
                  task: { id: t.id, status: t.status },
                  deps,
                  dependents: dependentCount.get(t.id) ?? 0,
                });
              }
            }

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
              prLifecycleStatus: result?.prUrl ? (prLifecycleByTaskId.get(t.id) ?? null) : null,
              summary: result?.summary || null,
              hasArtifact: !!result?.structuredOutput || (result?.files?.length ?? 0) > 0,
              filesChanged: result?.files?.length ?? null,
              waitingPrompt: waitingFor ? (waitingFor.prompt || 'Needs input') : null,
              missionId: t.missionId || null,
              missionTitle: t.missionId ? (missionTitleMap.get(t.missionId) || null) : null,
              budgetPaused,
              budgetBackend: backendLabel(t.backend),
              budgetResetsAt: budgetPaused ? ((ctx.budgetResetsAt as string | undefined) || null) : null,
              startAt: t.startAt?.toISOString() || null,
              loopIteration: t.loopConfig ? t.loopIteration : null,
              loopState: t.loopState,
              loopMaxLoops: t.loopConfig ? (t.loopConfig.maxLoops ?? 5) : null,
              workerStatus: activeW?.status ?? null,
              workerStartedAt: activeW?.startedAt ?? null,
              workerUpdatedAt: activeW?.updatedAt ?? null,
              runnerName: activeW?.name ?? null,
              chain,
              attemptCurrent: typeof ctx.iteration === 'number' ? ctx.iteration + 1 : null,
              attemptTotal: typeof ctx.maxIterations === 'number' ? ctx.maxIterations : null,
              taskType: deriveTaskType({ title: t.title, parentTaskId: t.parentTaskId, mode: t.mode }),
              parentTaskId: t.parentTaskId ?? null,
              taskClass: t.taskClass ?? null,
              loopExitConditionType: (t.loopConfig as any)?.exitCondition?.type ?? null,
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
      initiativeFilter={initiativeId || null}
      initiativeTitle={initiativeTitle}
      initiativeMissionIds={initiativeMissionIds}
    />
  );
}
