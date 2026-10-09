import { db } from '@buildd/core/db';
import { getOwnerDeliveryDisplays } from '@/lib/workflow/delivery-view';
import type { DeliveryDisplay } from '@/lib/workflow/delivery-display';
import { tasks, workers, workspaces as workspacesTable, missions, initiatives, teams } from '@buildd/core/db/schema';
import { desc, eq, inArray, and, gte, isNull } from 'drizzle-orm';
import * as missionHelpers from '@buildd/core/mission-helpers';
import { deriveTaskType, type TaskType } from '@buildd/core/mission-helpers';
import { deriveDisplayStatus, LIVE_WORKER_STATUSES, deriveChainPosition, isSubjectDead } from '@/lib/task-presentation';
import { BYPASS_MISSION_BUDGET_KEY, hasBypassFlag } from '@/lib/bypass-flags';
import { redirect, unstable_rethrow } from 'next/navigation';
import { cookies } from 'next/headers';
import { getCurrentUser } from '@/lib/auth-helpers';
import { resolveActiveTeamId, getTeamWorkspaceIds } from '@/lib/team-access';
import { displayWorkspaceName } from '@buildd/shared';
import type { ChainPositionResult, ChainPositionDep } from '@/lib/task-presentation';
import TaskGrid from './TaskGrid';
import ActivityView from './ActivityView';
import {
  loadActivity, loadLiveRootIds, ACTIVITY_CHILD_LIMIT, ACTIVITY_ROOT_LIMIT, ACTIVITY_WINDOW_DAYS, type ActivityData,
} from './activity-data';
import { listLocalSessions, type LocalSessionView } from '@/lib/local-session-view';
import { localHoldsByWorker } from '@/lib/local-session-display';
import { parseTaskListSelection } from '@/lib/task-list-filters';
import { backendLabel } from '@buildd/core/backend-policy';

export default async function TasksPage({
  searchParams,
}: {
  searchParams: Promise<{ mission?: string; workspace?: string; initiative?: string; ids?: string | string[]; selection?: string; view?: string }>;
}) {
  const params = await searchParams;
  const { mission: missionId, workspace: wsFilter, initiative: initiativeId } = params;

  const isDev = process.env.NODE_ENV === 'development' && (!process.env.DATABASE_URL || !process.env.DEV_USER_EMAIL); // placeholder unless dev has a DB + dev user
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
    delivery: DeliveryDisplay | null;
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
    subjectDead: boolean;
    missionBudgetExhausted: boolean;
  }> = [];

  const taskListFilter = parseTaskListSelection(params);
  let teamWorkspaces: { id: string; name: string }[] = [];
  let initiativeTitle: string | null = null;
  let initiativeMissionIds: string[] = [];
  let localSessions: LocalSessionView[] = [];
  // Now/History (the default view). A band drill-down (`?ids=`/`?selection=`)
  // is a historical list another surface links to and keeps TaskGrid.
  let activity: ActivityData | null = null;
  let teamName: string | null = null;
  // A failed load says so; it never renders as an empty Now and History.
  let loadFailed = false;

  if (!isDev && user) {
    try {
      const cookieStore = await cookies();
      const activeTeamId = await resolveActiveTeamId(user.id, cookieStore.get('buildd-team')?.value);

      if (activeTeamId) {
        // Query team name for the header eyebrow
        try {
          const team = await db.query.teams.findFirst({
            where: eq(teams.id, activeTeamId),
            columns: { name: true },
          });
          teamName = team?.name || null;
        } catch {}

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
          // Presence of local interactive sessions. Best-effort: the task list
          // never waits on or fails because of it.
          try {
            localSessions = await listLocalSessions({ workspaceIds: wsIds });
          } catch (err) {
            console.warn('[tasks] local sessions query failed:', err);
          }
          // A task a local session is working on names that client, not a runner.
          const localClientByTaskId = new Map(
            localSessions.flatMap(s => s.tasks.filter(t => t.live).map(t => [t.id, `${s.clientLabel} · local`] as const)),
          );
          const localHolds = localHoldsByWorker(localSessions);
          const bandIds = taskListFilter?.ids ?? null;
          const taskColumns = {
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
            // Subject-liveness gate inputs. subjectAnchor carries `source`,
            // which decides whether the anchor gates claims at all — an
            // unselected column reads as undefined and the row would render
            // as a healthy QUEUED task again.
            subjectKind: true,
            subjectPrNumber: true,
            subjectResolution: true,
            subjectAnchor: true,
          } as const;
          // Band membership is historical, so it must not use current task status.
          // Otherwise: recent roots (the History window) plus every live root, however old.
          const windowStart = new Date(Date.now() - ACTIVITY_WINDOW_DAYS * 24 * 60 * 60 * 1000);
          const [recentTasks, liveRootIds] = await Promise.all([
            db.query.tasks.findMany({
              where: and(
                inArray(tasks.workspaceId, wsIds),
                bandIds ? inArray(tasks.id, bandIds) : gte(tasks.updatedAt, windowStart),
                bandIds ? undefined : isNull(tasks.parentTaskId),
              ),
              columns: taskColumns,
              orderBy: [desc(tasks.updatedAt)],
              limit: bandIds ? 5000 : ACTIVITY_ROOT_LIMIT,
            }),
            bandIds ? Promise.resolve([] as string[]) : loadLiveRootIds(wsIds),
          ]);
          const loadedRootIds = new Set(recentTasks.map(t => t.id));
          const missingLiveIds = liveRootIds.filter(id => !loadedRootIds.has(id));
          const liveRoots = missingLiveIds.length > 0
            ? await db.query.tasks.findMany({
                where: and(inArray(tasks.workspaceId, wsIds), inArray(tasks.id, missingLiveIds)),
                columns: taskColumns,
              })
            : [];
          const rootTasks = [...recentTasks, ...liveRoots];

          // Fetch child tasks (retry/reviewer) for the root tasks we loaded,
          // newest first so a cap drops the oldest attempts, never a live one.
          const rootIds = rootTasks.map(t => t.id);
          const childTasks = rootIds.length > 0
            ? await db.query.tasks.findMany({
                where: and(inArray(tasks.workspaceId, wsIds), inArray(tasks.parentTaskId, rootIds)),
                columns: taskColumns,
                orderBy: [desc(tasks.createdAt)],
                limit: ACTIVITY_CHILD_LIMIT,
              })
            : [];
          const allTasks = [...new Map([...rootTasks, ...childTasks].map(t => [t.id, t])).values()];

          // Fetch mission titles for tasks that have missionId
          const missionIds = [...new Set(allTasks.map(t => t.missionId).filter(Boolean))] as string[];
          const missionTitleMap = new Map<string, string>();
          // Missions whose cost budget is spent. The claim loop's mission gate #1
          // skips EVERY task in such a mission and only a human raising
          // costBudgetUsd clears it, so these rows must not render as QUEUED.
          const budgetExhaustedMissionIds = new Set<string>();
          if (missionIds.length > 0) {
            const misns = await db.query.missions.findMany({
              where: inArray(missions.id, missionIds),
              // `status` is load-bearing, not decorative: this query selects
              // columns explicitly, and an unselected column reads as undefined,
              // which computes the gate flag to false and silently re-hides the
              // stall. Same failure mode as the subject-liveness columns below.
              columns: { id: true, title: true, initiativeId: true, status: true },
            });
            for (const m of misns) {
              missionTitleMap.set(m.id, m.title);
              if (m.status === 'budget_exhausted') budgetExhaustedMissionIds.add(m.id);
              if (initiativeId && m.initiativeId === initiativeId) {
                initiativeMissionIds.push(m.id);
              }
            }
          }

          if (!taskListFilter) {
            const inView = allTasks.filter(t => {
              if (missionId) return t.missionId === missionId;
              if (initiativeId) return !!t.missionId && initiativeMissionIds.includes(t.missionId);
              return true;
            });
            activity = await loadActivity({ tasks: inView, missionTitles: missionTitleMap, localHolds, now: Date.now(), rules: missionHelpers });
          } else {
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
          // §17.5: a kernel-owned delivery's stage and PR state, not the columns.
          const deliveryByTaskId = await getOwnerDeliveryDisplays(allTasks.map(t => t.id));
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
              delivery: deliveryByTaskId.get(t.id) ?? null,
              summary: result?.summary || null,
              hasArtifact: !!result?.structuredOutput || (result?.files?.length ?? 0) > 0,
              filesChanged: result?.files?.length ?? null,
              mismatchCount: Array.isArray((t.result as { mismatch?: unknown[] } | null)?.mismatch)
                ? (t.result as { mismatch: unknown[] }).mismatch.length
                : 0,
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
              runnerName: localClientByTaskId.get(t.id) ?? activeW?.name ?? null,
              chain,
              attemptCurrent: typeof ctx.iteration === 'number' ? ctx.iteration + 1 : null,
              attemptTotal: typeof ctx.maxIterations === 'number' ? ctx.maxIterations : null,
              taskType: deriveTaskType({ title: t.title, parentTaskId: t.parentTaskId, mode: t.mode }),
              parentTaskId: t.parentTaskId ?? null,
              taskClass: t.taskClass ?? null,
              loopExitConditionType: (t.loopConfig as any)?.exitCondition?.type ?? null,
              // Same predicate the claim gate enforces in SQL — a task the gate
              // excludes must not render as QUEUED.
              subjectDead: isSubjectDead(t),
              // Mission budget wall. Terminal rows are exempt (the gate only
              // ever blocked a claim), and an operator force-start writes
              // context.bypassMissionBudget — after which the claim loop DOES
              // take the task, so flagging it here would contradict the gate
              // that is actually in force.
              missionBudgetExhausted:
                !isTerminal
                && !!t.missionId
                && budgetExhaustedMissionIds.has(t.missionId)
                && !hasBypassFlag(ctx, BYPASS_MISSION_BUDGET_KEY),
            };
          });
          }
        }
      }
    } catch (error) {
      unstable_rethrow(error);
      console.error('Tasks grid query error:', error);
      loadFailed = true;
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

  if (activity || !taskListFilter) {
    const mode = params.view === 'history' ? 'history' : 'now';
    const href = (view: 'now' | 'history') => {
      const q = new URLSearchParams();
      if (missionId) q.set('mission', missionId);
      if (wsFilter) q.set('workspace', wsFilter);
      if (initiativeId) q.set('initiative', initiativeId);
      if (view === 'history') q.set('view', 'history');
      const qs = q.toString();
      return `/app/tasks${qs ? `?${qs}` : ''}`;
    };
    return (
      <ActivityView
        mode={mode}
        now={activity?.now ?? { groups: [], inMotion: 0, liveAgents: 0 }}
        history={activity?.history ?? []}
        latest={activity?.latest ?? null}
        nowMs={Date.now()}
        hrefs={{ now: href('now'), history: href('history') }}
        missionFilter={missionId ? { id: missionId, title: missionTitle } : null}
        initiativeTitle={initiativeTitle}
        localSessions={localSessions}
        loadError={loadFailed}
      />
    );
  }

  return (
    <TaskGrid
      key={taskListFilter?.label ?? 'tasks'}
      bandFilterLabel={taskListFilter?.label}
      tasks={gridTasks}
      missionFilter={missionId || null}
      missionTitle={missionTitle}
      workspaces={teamWorkspaces}
      selectedWorkspaceId={wsFilter ?? null}
      initiativeFilter={initiativeId || null}
      initiativeTitle={initiativeTitle}
      initiativeMissionIds={initiativeMissionIds}
      localSessions={localSessions}
      teamName={teamName}
    />
  );
}
