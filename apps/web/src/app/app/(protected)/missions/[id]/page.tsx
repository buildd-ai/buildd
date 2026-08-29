import { db } from '@buildd/core/db';
import { missions, workspaces, workspaceSkills, missionNotes, workers, tasks, initiatives } from '@buildd/core/db/schema';
import { eq, and, inArray, desc, isNotNull, isNull, ne } from 'drizzle-orm';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth-helpers';
import { getUserTeamIds, getUserWorkspaceIds } from '@/lib/team-access';
import { deriveMissionHealth, deriveTaskHealthSignal, formatNextRun, deriveMissionDisplayState, getMissionStateChip } from '@/lib/mission-helpers';
import { computeMissionProgress, deriveTaskType, computeMissionSkyline } from '@buildd/core/mission-helpers';
import { MissionProgressBar } from '@/components/MissionProgressBar';
import { deriveChainPosition, type ChainPositionResult, type ChainPositionDep } from '@/lib/task-presentation';
import { getHeartbeatStatus, isOverdue as checkOverdue } from '@/lib/heartbeat-helpers';
import { isSystemWorkspace, displayWorkspaceName } from '@buildd/shared';
import { resolvePolicy } from '@/lib/merge-policy';
import MissionSettings from './MissionSettings';
import MissionMergePolicyRow from '@/components/MissionMergePolicyRow';
import MissionReviewSummary from './MissionReviewSummary';
import MissionInitiativeSelector, { type InitiativeOption } from './MissionInitiativeSelector';
import MissionInlineEdit from './MissionInlineEdit';
import MissionAutoRefresh from './MissionAutoRefresh';
import MissionReconcileOnOpen from './MissionReconcileOnOpen';
import CondensedTimeline from './CondensedTimeline';
import type { CondensedTimelineGroups, CondensedTimelineTask, BookkeepingTask } from './CondensedTimeline';
import { groupChainUnits } from '@/lib/condensed-timeline';
import type { CondensedTask, CondensedTaskWorker, ChainUnit } from '@/lib/condensed-timeline';
import TaskPanelWrapper from './TaskPanelWrapper';
import HeartbeatStatusBadge from './HeartbeatStatusBadge';
import HeartbeatChecklistEditor from './HeartbeatChecklistEditor';
import QuietHoursConfig from './QuietHoursConfig';
import HeartbeatTimeline from './HeartbeatTimeline';
import MissionBackendSelector from './MissionBackendSelector';
import MissionMonitoringToggle from './MissionMonitoringToggle';
import ScheduleWizard from './ScheduleWizard';
import MissionConfig from './MissionConfig';
import MissionTabs from './MissionTabs';
import MissionFeed from './MissionFeed';
import MissionSecondaryPanel from './MissionSecondaryPanel';
import MissionGoalCriteria from './MissionGoalCriteria';
import RaiseBudgetButton from './RaiseBudgetButton';
import { getMissionSpendUsd } from '@/lib/mission-budget';
import { getLinksForEntity } from '@buildd/core/external-links';
import TrackerProgressPanel from '@/components/TrackerProgressPanel';
import MissionArtifacts from '@/components/missions/MissionArtifacts';
import { resolveMissionBreadcrumb } from '@/lib/initiative-breadcrumb';
import { SwipeProvider } from '@/components/SwipeableRow';
import { refreshWorkerMergeStateIfStale } from '@/lib/pr-reconcile';

export const dynamic = 'force-dynamic';


export default async function MissionDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ from?: string; initiativeId?: string; artifact?: string }>;
}) {
  const { id } = await params;
  const { from, initiativeId, artifact: initialOpenArtifactId } = await searchParams;
  const user = await getCurrentUser();
  if (!user) redirect('/app/auth/signin');

  const teamIds = await getUserTeamIds(user.id);

  let mission = await db.query.missions.findFirst({
    where: eq(missions.id, id),
    with: {
      workspace: { columns: { id: true, name: true } },
      initiative: { columns: { id: true, title: true } },
      tasks: {
        columns: {
          id: true,
          title: true,
          status: true,
          priority: true,
          createdAt: true,
          updatedAt: true,
          result: true,
          mode: true,
          roleSlug: true,
          creationSource: true,
          dependsOn: true,
          parentTaskId: true,
          category: true,
          taskClass: true,
          loopConfig: true,
          loopState: true,
          loopIteration: true,
          startAt: true,
        },
        orderBy: (t: any, { desc }: any) => [desc(t.createdAt)],
        with: {
          workers: {
            columns: {
              id: true,
              status: true,
              waitingFor: true,
              branch: true,
              prUrl: true,
              prNumber: true,
              prLifecycleStatus: true,
              mergedAt: true,
              costUsd: true,
              turns: true,
              completedAt: true,
              startedAt: true,
              currentAction: true,
              commitCount: true,
              filesChanged: true,
            },
            orderBy: (w: any, { desc }: any) => [desc(w.startedAt)],
            limit: 3,
            with: {
              artifacts: {
                columns: {
                  id: true,
                  type: true,
                  title: true,
                  key: true,
                  shareToken: true,
                  content: true,
                  visibility: true,
                  metadata: true,
                  createdAt: true,
                },
                limit: 5,
              },
            },
          },
        },
      },
      schedule: true,
    },
  });

  if (!mission || !teamIds.includes(mission.teamId)) {
    notFound();
  }

  // Read-through refresh: stamp mergedAt on any completed workers whose PR
  // webhook was missed, so the timeline renders the correct state immediately.
  if (mission.workspaceId) {
    const staleWorkers = (mission.tasks ?? []).flatMap(t => {
      if (t.status !== 'completed') return [];
      const w = (t.workers as any[])?.[0];
      if (!w?.prNumber || w?.mergedAt || !w?.prUrl) return [];
      return [{ id: w.id as string, prNumber: w.prNumber as number, prUrl: w.prUrl as string }];
    });
    if (staleWorkers.length > 0) {
      const wsWithInstall = await db.query.workspaces.findFirst({
        where: eq(workspaces.id, mission.workspaceId),
        columns: {},
        with: { githubInstallation: { columns: { installationId: true } } },
      });
      const installId = wsWithInstall?.githubInstallation?.installationId;
      if (installId) {
        const refreshed = await Promise.all(
          staleWorkers.map(w => refreshWorkerMergeStateIfStale(w, installId))
        );
        if (refreshed.some(Boolean)) {
          const refreshedMission = await db.query.missions.findFirst({
            where: eq(missions.id, id),
            with: {
              workspace: { columns: { id: true, name: true } },
              initiative: { columns: { id: true, title: true } },
              tasks: {
                columns: {
                  id: true, title: true, status: true, priority: true, createdAt: true,
                  updatedAt: true, result: true, mode: true, roleSlug: true,
                  creationSource: true, dependsOn: true, parentTaskId: true, category: true,
                  taskClass: true, loopConfig: true, loopState: true, loopIteration: true, startAt: true,
                },
                orderBy: (t: any, { desc }: any) => [desc(t.createdAt)],
                with: {
                  workers: {
                    columns: {
                      id: true, status: true, waitingFor: true, branch: true, prUrl: true,
                      prNumber: true, prLifecycleStatus: true, mergedAt: true, costUsd: true,
                      turns: true, completedAt: true, startedAt: true, currentAction: true,
                      commitCount: true, filesChanged: true,
                    },
                    orderBy: (w: any, { desc }: any) => [desc(w.startedAt)],
                    limit: 3,
                    with: {
                      artifacts: {
                        columns: {
                          id: true, type: true, title: true, key: true, shareToken: true,
                          content: true, visibility: true, metadata: true, createdAt: true,
                        },
                        limit: 5,
                      },
                    },
                  },
                },
              },
              schedule: true,
            },
          });
          if (refreshedMission) mission = refreshedMission;
        }
      }
    }
  }

  // Query roles and workspaces for this user
  const wsIds = await getUserWorkspaceIds(user.id);
  let roles: { slug: string; name: string; color: string }[] = [];
  let teamWorkspaces: { id: string; name: string }[] = [];
  if (wsIds.length > 0) {
    const [rolesResult, workspacesResult] = await Promise.all([
      db.query.workspaceSkills.findMany({
        where: and(
          inArray(workspaceSkills.workspaceId, wsIds),
          eq(workspaceSkills.enabled, true),
        ),
        columns: { slug: true, name: true, color: true },
        orderBy: [desc(workspaceSkills.createdAt)],
      }),
      db.query.workspaces.findMany({
        where: inArray(workspaces.teamId, teamIds),
        columns: { id: true, name: true },
      }),
    ]);
    roles = rolesResult;
    teamWorkspaces = workspacesResult;
  }

  // Fetch reviewer verdict notes for BT-16 (verdict chips)
  const allMissionTaskIds = (mission.tasks || []).map(t => t.id);
  const reviewerNotes = allMissionTaskIds.length > 0
    ? await db.query.missionNotes.findMany({
        where: and(
          inArray(missionNotes.taskId, allMissionTaskIds),
          inArray(missionNotes.type, ['reviewer_approved', 'reviewer_request_changes', 'reviewer_escalated'] as any[]),
        ),
        columns: {
          taskId: true,
          type: true,
          title: true,
          body: true,
          status: true,
          supersededByPrNumber: true,
          createdAt: true,
        },
        orderBy: desc(missionNotes.createdAt),
      })
    : [];

  // Map taskId → latest reviewer note
  const reviewerNoteMap = new Map<string, {
    type: string;
    title: string;
    body: string | null;
    status: string;
    supersededByPrNumber: number | null;
    createdAt: Date;
  }>();
  for (const note of reviewerNotes) {
    if (note.taskId && !reviewerNoteMap.has(note.taskId)) {
      reviewerNoteMap.set(note.taskId, note);
    }
  }

  // BT-13: count tasks awaiting merge (completed + has open PR + not yet merged)
  const awaitingMerge = (mission.tasks || []).filter(t => {
    if (t.status !== 'completed') return false;
    const latestWorker = (t.workers as any[])?.[0];
    return latestWorker?.prUrl && !latestWorker?.mergedAt && latestWorker?.prLifecycleStatus !== 'closed';
  }).length;

  // BT-21: resolve effective merge policy tier for mission header chip
  const workspaceForPolicy = mission.workspaceId
    ? await db.query.workspaces.findFirst({
        where: eq(workspaces.id, mission.workspaceId),
        columns: { id: true, gitConfig: true },
      })
    : null;
  const effectivePolicy = resolvePolicy(
    workspaceForPolicy ?? { gitConfig: null },
    { mergePolicy: (mission as any).mergePolicy ?? null },
  );
  const workspaceDefaultPolicy = resolvePolicy(workspaceForPolicy ?? { gitConfig: null });
  const hasPolicyOverride = (mission as any).mergePolicy != null;
  const policyTierLabel: Record<string, string> = {
    'auto-threshold': 'Auto',
    'agent-review': 'Agent Review',
    'human': 'Human Gate',
  };
  const policyLabel = policyTierLabel[effectivePolicy.tier] ?? effectivePolicy.tier;

  // Raw count for "View all N tasks" links — includes bookkeeping and cancelled,
  // but excludes attempt tasks (CI retries, reviewer runs) since they nest under parents.
  const allTasksCount = (mission.tasks || []).filter(t => t.taskClass !== 'attempt').length;
  // Progress uses deliverable non-cancelled tasks only so cancelled duplicates
  // don't inflate the denominator and block the mission from reaching 100%.
  const { totalTasks, completedTasks, progress: progressPct, segments } = computeMissionProgress(mission.tasks || []);
  // Completed missions always show 100% regardless of individual task outcomes.
  const progress = mission.status === 'completed' ? 100 : progressPct;
  // Invariant: PRs ≤ totalTasks when totalTasks > 0. A violation means the attempt
  // filter is still overcollapsing or the PR counter is double-counting.
  if (process.env.NODE_ENV === 'development' && totalTasks > 0) {
    const prCount = (mission.tasks ?? []).flatMap(t => (t.workers as any[] ?? [])).filter(w => w.prUrl).length;
    if (prCount > totalTasks) {
      console.error(`[mission-invariant] mission ${id}: PRS (${prCount}) > TASKS (${totalTasks}) — check attempt-filter logic in computeMissionProgress.`);
    }
  }

  const activeAgents = mission.tasks
    ?.flatMap((t) => t.workers || [])
    .filter((w) => w.status === 'running').length || 0;

  const scheduleCron = (mission.schedule as any)?.cronExpression || null;
  const health = deriveMissionHealth({
    status: mission.status,
    activeAgents,
    cronExpression: scheduleCron,
    lastRunAt: (mission.schedule as any)?.lastRunAt || null,
    nextRunAt: (mission.schedule as any)?.nextRunAt || null,
  });
  const healthState = deriveTaskHealthSignal(mission, mission.tasks || []);

  // Orchestration mode
  const orchestrationMode = (mission.orchestrationMode as 'auto' | 'manual') ?? 'auto';
  const isHeld = (mission as any).isHeld === true;

  // Goal criteria that have not been verified keep the mission open — the header
  // must say that rather than "READY FOR REVIEW".
  const missionCriteria = (mission as any).goalCriteria as unknown[] | null;
  const missionCriteriaOverall = ((mission as any).goalCriteriaState as { overall?: string } | null)?.overall ?? null;
  const criteriaUnverified = Array.isArray(missionCriteria) && missionCriteria.length > 0 && missionCriteriaOverall !== 'pass';

  // Single derived display state for the header chip and CTA
  const displayState = deriveMissionDisplayState({
    status: mission.status,
    isHeld,
    orchestrationMode,
    activeAgents,
    health: healthState,
    progress,
    criteriaUnverified,
  });
  const stateChip = getMissionStateChip(displayState);
  const detailNextRunAt = (mission.schedule as any)?.nextRunAt;
  const detailNextScanMins = detailNextRunAt ? Math.max(0, Math.round((new Date(detailNextRunAt).getTime() - Date.now()) / 60_000)) : null;
  const driveNextRun = formatNextRun(detailNextScanMins, detailNextRunAt ? String(detailNextRunAt) : null);
  const inFlightTasks = (mission.tasks || []).flatMap(t => (t.workers || []).filter(w => ['idle', 'running', 'starting', 'waiting_input'].includes(w.status)).map(w => ({ id: t.id, title: t.title, startedAt: w.startedAt ? String(w.startedAt) : null, turns: w.turns })));

  // Heartbeat data — derived from schedule's taskTemplate.context
  const templateContext = (mission.schedule as any)?.taskTemplate?.context as Record<string, unknown> | undefined;
  const isHeartbeat = (templateContext?.heartbeat === true) || false;
  const heartbeatChecklist = (templateContext?.heartbeatChecklist as string) ?? null;
  const activeHoursStart = (templateContext?.activeHoursStart as number) ?? null;
  const activeHoursEnd = (templateContext?.activeHoursEnd as number) ?? null;
  const activeHoursTimezone = (templateContext?.activeHoursTimezone as string) ?? null;

  // Configuration from schedule template
  const configModel = (templateContext?.model as string) || null;

  // Cost budget
  const costBudgetUsd = (mission as any).costBudgetUsd as string | null ?? null;
  const spendUsd = costBudgetUsd != null ? await getMissionSpendUsd(id) : null;

  // Settings panel summary — non-default values for the collapsed header
  const configSummaryParts: string[] = [];
  if (configModel) configSummaryParts.push(configModel.replace(/^claude-/, '').replace(/-latest$/, ''));
  if (mission.maxConcurrentTasks != null) configSummaryParts.push(`${mission.maxConcurrentTasks} concurrent`);
  if (costBudgetUsd != null) configSummaryParts.push(`$${parseFloat(costBudgetUsd).toFixed(0)} budget`);
  const configSummary = configSummaryParts.length > 0 ? configSummaryParts.join(', ') : null;

  // Linear Phase 2: only mount the tracking panel if this mission has a linear link.
  const trackerLinks = await getLinksForEntity(db, 'mission', id);

  // Heartbeat status
  const { lastStatus: lastHeartbeatStatus, lastAt: lastHeartbeatAt } = getHeartbeatStatus(
    (mission.tasks || []).map(t => ({
      id: t.id,
      createdAt: t.createdAt,
      status: t.status,
      result: t.result,
    }))
  );
  const TERMINAL_STATUSES = ['completed', 'cancelled', 'budget_exhausted'];
  const heartbeatOverdue = isHeartbeat && !TERMINAL_STATUSES.includes(mission.status) && mission.schedule?.nextRunAt && scheduleCron
    ? checkOverdue(mission.schedule.nextRunAt, scheduleCron)
    : false;

  const scheduleNextRunAt = (mission.schedule as any)?.nextRunAt as string | null | undefined;
  const scheduleNextMs = scheduleNextRunAt ? new Date(scheduleNextRunAt).getTime() : null;
  const scheduleOverdue = mission.status === 'active' && scheduleNextMs != null && scheduleNextMs < Date.now();
  const scheduleOverdueMinutes = scheduleOverdue && scheduleNextMs != null ? Math.floor((Date.now() - scheduleNextMs) / 60000) : 0;
  const heartbeatTasks = isHeartbeat
    ? (mission.tasks || []).filter(t => t.status === 'completed' || t.status === 'failed')
    : [];

  // Build roles map for color lookup
  const rolesMap = new Map<string, { name: string; color: string }>();
  roles.forEach((r) => rolesMap.set(r.slug, { name: r.name, color: r.color }));

  // Build task ID map for blocked-state computation (dependsOn resolution)
  const taskMap = new Map((mission.tasks || []).map((t) => [t.id, t]));

  // A task is "blocked" when it has unresolved dependsOn entries (upstream task
  // not yet completed, or completed but PR not yet merged).
  function getBlockingTask(task: typeof allTasks[0]) {
    const deps = (task.dependsOn as string[] | null | undefined) ?? [];
    if (deps.length === 0) return null;
    if (task.status !== 'pending' && task.status !== 'assigned') return null;
    for (const depId of deps) {
      const dep = taskMap.get(depId);
      if (!dep) continue;
      if (dep.status !== 'completed') return dep;
      // Completed but PR not yet merged → still blocking
      const depWorker = (dep.workers as Array<{ prNumber?: number | null; mergedAt?: string | Date | null }> | null | undefined)?.[0];
      if (depWorker?.prNumber && !depWorker.mergedAt) return dep;
    }
    return null;
  }

  // Build orchestration timeline: group tasks into cycles
  // Planning tasks = evaluation nodes, execution tasks = branches
  const allTasks = (mission.tasks || []).slice().sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
  );

  // BT-16: Map reviewer tasks by their parentTaskId for chip tappability.
  // Reviewer tasks (category='review') are NOT shown as separate timeline rows;
  // they surface as inline verdict chips on the task they reviewed.
  const reviewerTaskMap = new Map<string, { id: string; status: string }>();
  for (const t of allTasks) {
    if (t.category === 'review' && t.parentTaskId) {
      reviewerTaskMap.set(t.parentTaskId, { id: t.id, status: t.status });
    }
  }

  // §3.6: Deliverable tasks appear in the timeline; bookkeeping tasks (attempts,
  // reviewer runs, orchestration planning) collapse to the expandable footer.
  // taskClass='work' → timeline; 'attempt'|'bookkeeping' → housekeeping footer.
  const isBookkeeping = (t: typeof allTasks[0]): boolean => t.taskClass !== 'work';

  const timelineTasks = allTasks.filter(t => !isBookkeeping(t));

  // Collect bookkeeping tasks for the expandable footer
  const bookkeepingTasksRaw = allTasks.filter(t => isBookkeeping(t));
  const bookkeepingTasks: BookkeepingTask[] = bookkeepingTasksRaw.map(t => {
    const lw = (t.workers as any[])?.[0];
    return {
      id: t.id,
      title: t.title,
      taskUpdatedAt: t.updatedAt.toISOString(),
      latestWorker: lw ? { prUrl: lw.prUrl ?? null, mergedAt: lw.mergedAt ? String(lw.mergedAt) : null } : null,
    };
  });

  // Compute chain positions for mission tasks
  const chainByTaskId = new Map<string, ChainPositionResult | null>();
  for (const task of allTasks) {
    const depIds = (task.dependsOn as string[] | null) ?? [];
    if (depIds.length === 0) {
      chainByTaskId.set(task.id, null);
      continue;
    }
    const deps = depIds.map(depId => {
      const dep = taskMap.get(depId);
      if (!dep) return null;
      // Map every loaded worker, not just the latest: the gate asks whether ANY
      // worker holds an open PR. prLifecycleStatus='closed' releases the guard.
      const depWorkers = (dep.workers as Array<{ prUrl?: string | null; prNumber?: number | null; mergedAt?: Date | string | null; prLifecycleStatus?: string | null }> | null) ?? [];
      return {
        id: dep.id,
        title: dep.title,
        status: dep.status,
        dependsOn: (dep.dependsOn as string[] | null) ?? [],
        workers: depWorkers.map(w => ({
          prUrl: w.prUrl ?? null,
          prNumber: w.prNumber ?? null,
          mergedAt: w.mergedAt ? String(w.mergedAt) : null,
          prLifecycleStatus: w.prLifecycleStatus ?? null,
        })),
      };
    }).filter(Boolean) as ChainPositionDep[];
    const dependents = allTasks.filter(t => ((t.dependsOn as string[] | null) ?? []).includes(task.id)).length;
    chainByTaskId.set(task.id, deriveChainPosition({ task: { id: task.id, status: task.status }, deps, dependents }));
  }

  // ── I-7: Condensed timeline — build groups ────────────────────────────────

  // Normalise a DB worker row to CondensedTaskWorker (all strings, no Date objects)
  function normaliseWorker(w: {
    id: string;
    status: string;
    prUrl?: string | null;
    prNumber?: number | null;
    prLifecycleStatus?: string | null;
    mergedAt?: Date | string | null;
    completedAt?: Date | string | null;
    startedAt?: Date | string | null;
    currentAction?: string | null;
    branch?: string | null;
    waitingFor?: unknown;
  }): CondensedTaskWorker {
    return {
      id: w.id,
      status: w.status,
      prUrl: w.prUrl ?? null,
      prNumber: w.prNumber ?? null,
      prLifecycleStatus: w.prLifecycleStatus ?? null,
      mergedAt: w.mergedAt ? String(w.mergedAt) : null,
      completedAt: w.completedAt ? String(w.completedAt) : null,
      startedAt: w.startedAt ? String(w.startedAt) : null,
      currentAction: w.currentAction ?? null,
      branch: w.branch ?? null,
      waitingFor: (w.waitingFor as { type: string; prompt: string; options?: string[] } | null) ?? null,
    };
  }

  // Build CondensedTask objects for the grouping function
  const condensedTasksForGrouping: CondensedTask[] = timelineTasks.map(task => {
    // Under agent-review policy: approved, escalated, and request_changes all require
    // human awareness — place them in Waiting-on-you (§3.7: Changes Requested never buried).
    // Under other policies (auto-threshold, human), any open PR awaits human merge.
    let humanActionPending: boolean;
    if (effectivePolicy.tier === 'agent-review') {
      const note = reviewerNoteMap.get(task.id);
      humanActionPending =
        note?.type === 'reviewer_approved' ||
        note?.type === 'reviewer_escalated' ||
        note?.type === 'reviewer_request_changes';
    } else {
      humanActionPending = true;
    }
    return {
      id: task.id,
      status: task.status,
      dependsOn: (task.dependsOn as string[] | null) ?? null,
      workers: ((task.workers || []) as any[]).map(normaliseWorker),
      humanActionPending,
    };
  });
  const condensedTaskMapForGrouping = new Map(condensedTasksForGrouping.map(t => [t.id, t]));

  const rawGroups = groupChainUnits(condensedTasksForGrouping, condensedTaskMapForGrouping);

  // Mission-level claim gate, hoisted once: `mission` is a reassignable `let`, so
  // TS cannot narrow it inside the closure below.
  const missionBudgetExhausted = mission?.status === 'budget_exhausted';

  // Convert a raw group member to a CondensedTimelineTask with enriched display fields
  function toTimelineTask(condensedTask: CondensedTask): CondensedTimelineTask {
    const task = taskMap.get(condensedTask.id)!;
    const role = task.roleSlug ? rolesMap.get(task.roleSlug) : null;
    const reviewerNote = reviewerNoteMap.get(task.id) ?? null;
    const reviewerTaskRef = reviewerTaskMap.get(task.id);
    return {
      id: task.id,
      title: task.title,
      status: task.status,
      taskCreatedAt: task.createdAt.toISOString(),
      taskUpdatedAt: task.updatedAt.toISOString(),
      roleColor: role?.color ?? '#8A8478',
      chain: chainByTaskId.get(task.id) ?? null,
      // Mission-level claim gate: a budget_exhausted mission blocks every one of
      // its pending tasks until a human raises the budget, and it never clears on
      // its own. Surfacing it per row keeps this timeline from showing an
      // unclaimable task as QUEUED (rule CG-2).
      missionBudgetExhausted: missionBudgetExhausted,
      latestWorker: condensedTask.workers[0] ?? null,
      taskType: deriveTaskType({ title: task.title, parentTaskId: task.parentTaskId, mode: task.mode }),
      loopState: task.loopState ?? null,
      loopMaxLoops: task.loopConfig ? ((task.loopConfig as any).maxLoops ?? 5) : null,
      loopIteration: task.loopConfig ? task.loopIteration : null,
      startAt: task.startAt?.toISOString() ?? null,
      loopExitConditionType: (task.loopConfig as any)?.exitCondition?.type ?? null,
      reviewerNote: reviewerNote
        ? {
            type: reviewerNote.type,
            title: reviewerNote.title,
            body: reviewerNote.body,
            status: reviewerNote.status,
            supersededByPrNumber: reviewerNote.supersededByPrNumber,
          }
        : null,
      reviewerTaskHref: reviewerTaskRef ? `/app/tasks/${reviewerTaskRef.id}` : null,
    };
  }

  function toChainUnit(chain: ChainUnit<CondensedTask>): ChainUnit<CondensedTimelineTask> {
    return { head: toTimelineTask(chain.head), tail: chain.tail.map(toTimelineTask), shape: chain.shape };
  }

  const timelineGroups: CondensedTimelineGroups = {
    waitingOnYou: rawGroups.waitingOnYou.map(toChainUnit),
    running: rawGroups.running.map(toChainUnit),
    nextQueued: rawGroups.nextQueued.map(toChainUnit),
    blocked: rawGroups.blocked.map(toChainUnit),
    done: rawGroups.done.map(toChainUnit),
    failed: rawGroups.failed.map(toChainUnit),
  };

  // §3.5: Density tier — Summary default for missions with > N_small deliverable tasks.
  // Use timelineTasks.length (exactly what renders in the timeline) instead of allTasksCount
  // (which inflates the count by including planning tasks that don't appear as rows).
  const N_SMALL = 8;
  const defaultView = timelineTasks.length > N_SMALL ? 'summary' : 'timeline';

  // PR roll-up counts for Summary view (§3.5)
  const allWorkers = allTasks.flatMap(t => (t.workers || []) as any[]);
  const prsMerged = allWorkers.filter(w => w.prUrl && (w.mergedAt || w.prLifecycleStatus === 'merged')).length;
  const prsOpen = allWorkers.filter(w => w.prUrl && !w.mergedAt && w.prLifecycleStatus !== 'merged' && w.prLifecycleStatus !== 'closed').length;

  // Collect all artifacts
  const allArtifacts = mission.tasks?.flatMap((t) =>
    t.workers?.flatMap((w) =>
      (w.artifacts || []).map((a) => ({ ...a, taskTitle: t.title, workerStatus: w.status }))
    ) || []
  ) || [];

  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://buildd.dev';

  const missionTaskIds = allTasks.map((t) => t.id);

  // Breadcrumb: URL param takes priority, DB-stored initiative is the fallback
  // so users see the parent initiative even when navigating directly to the mission.
  const initiativeName = (from === 'initiative' && initiativeId)
    ? (await db.query.initiatives.findFirst({
        where: eq(initiatives.id, initiativeId),
        columns: { title: true },
      }))?.title
    : undefined;

  const dbInitiative = (mission as any).initiative as { id: string; title: string } | null | undefined;

  const breadcrumb = resolveMissionBreadcrumb({
    from,
    initiativeId,
    initiativeName,
    dbInitiativeId: dbInitiative?.id,
    dbInitiativeName: dbInitiative?.title,
    missionTitle: mission.title,
  });

  // Fetch team's active/paused initiatives for the initiative selector
  const isTerminal = ['completed', 'archived'].includes(mission.status);
  const teamInitiativeOptions: InitiativeOption[] = isTerminal ? [] : await db.query.initiatives.findMany({
    where: and(
      inArray(initiatives.teamId, teamIds),
      inArray(initiatives.status, ['active', 'paused']),
    ),
    columns: { id: true, title: true, status: true },
    orderBy: [desc(initiatives.priority), desc(initiatives.createdAt)],
    limit: 50,
  }).then(rows => rows.map(r => ({ id: r.id, title: r.title, status: r.status, progress: 0 })));

  return (
    <SwipeProvider>
    <TaskPanelWrapper>
    <div className="px-4 md:px-10 pt-5 md:pt-8 pb-12 max-w-3xl">
      {/* Real-time updates via Pusher */}
      {mission.workspaceId && (
        <MissionAutoRefresh
          missionId={id}
          workspaceId={mission.workspaceId}
          taskIds={missionTaskIds}
        />
      )}

      {/* Freshen PR state on open — reconcile only, never a planning pass */}
      <MissionReconcileOnOpen missionId={id} />

      {/* Breadcrumbs */}
      <div className="flex items-center gap-2 text-[12px] text-text-muted mb-5">
        {breadcrumb.links.map((link, i) => (
          <span key={link.href} className="flex items-center gap-2">
            {i > 0 && <span>/</span>}
            <Link href={link.href} className="hover:text-text-secondary transition-colors">
              {link.label}
            </Link>
          </span>
        ))}
        <span>/</span>
        <span className="text-text-secondary truncate">{breadcrumb.currentLabel}</span>
      </div>

      {/* ── Status Block ── */}
      <div className="mb-6">
        <MissionInlineEdit
          missionId={id}
          initialTitle={mission.title}
          initialDescription={mission.description}
          healthPill={
            <span className="flex items-center gap-2 flex-wrap">
              {/* Single derived-state chip — replaces the old multi-badge soup */}
              <span className={`shrink-0 border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide ${stateChip.cls}`}>
                {stateChip.label}
              </span>
              {/* Next-run detail for auto missions with a schedule */}
              {displayState === 'active' && driveNextRun.text && (
                <span className="text-[10px] text-text-muted font-mono normal-case tracking-normal">{driveNextRun.text}</span>
              )}
              {isHeartbeat && (
                <HeartbeatStatusBadge
                  lastStatus={lastHeartbeatStatus}
                  lastAt={lastHeartbeatAt}
                  isOverdue={heartbeatOverdue}
                />
              )}
              {/* Policy chip — show only when overridden or has PRs awaiting merge */}
              {mission.workspaceId && (hasPolicyOverride || awaitingMerge > 0) && (
                <Link
                  href={`/app/settings/workspace/${mission.workspaceId}`}
                  className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono bg-surface-3 text-text-muted hover:text-text-secondary hover:bg-surface-2 transition-colors"
                  title={`Merge policy: ${policyLabel}${hasPolicyOverride ? ' (overridden)' : ' (inherited)'}`}
                >
                  <svg className="w-2.5 h-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M12 5v14m-7-7l7 7 7-7" />
                  </svg>
                  {policyLabel}
                  {hasPolicyOverride && <span className="opacity-60">·override</span>}
                </Link>
              )}
            </span>
          }
        />

        {/* Progress — shown for all missions with tasks */}
        {totalTasks > 0 && (
          <div className="card p-4 mb-4">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[13px] text-text-secondary">Progress</span>
              <span className="font-display text-lg text-status-success tabular-nums">
                {progress}%
              </span>
            </div>
            <MissionProgressBar density="full" missionId={id} segments={segments} completedTasks={completedTasks} totalTasks={totalTasks} inFlightTasks={inFlightTasks} />
            {/* BT-13: 'awaiting merge' count in progress display */}
            <div className="text-[12px] md:text-[11px] text-text-muted mt-1.5">
              {mission.status === 'completed'
                ? `${totalTasks} tasks · ${completedTasks} completed`
                : awaitingMerge > 0
                  ? `${completedTasks}/${totalTasks} done · ${awaitingMerge} awaiting merge`
                  : `${completedTasks} of ${totalTasks} tasks complete`}
            </div>
          </div>
        )}

        {/* Budget exhausted banner */}
        {mission.status === 'budget_exhausted' && costBudgetUsd != null && (
          <div className="card p-4 mb-4 border-status-error/40 border-l-2">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-[12px] font-semibold text-status-error uppercase tracking-wider">Budget exhausted</span>
                </div>
                <p className="text-[13px] text-text-secondary">
                  {spendUsd != null
                    ? `$${spendUsd.toFixed(4)} spent vs $${parseFloat(costBudgetUsd).toFixed(2)} budget — no new tasks will spawn.`
                    : `Budget of $${parseFloat(costBudgetUsd).toFixed(2)} reached — no new tasks will spawn.`}
                  {' '}Raise the budget to resume.
                </p>
              </div>
              <div className="shrink-0">
                <RaiseBudgetButton missionId={id} currentBudget={costBudgetUsd} />
              </div>
            </div>
          </div>
        )}

        {/* Spend vs budget (non-exhausted missions with a budget set) */}
        {costBudgetUsd != null && mission.status !== 'budget_exhausted' && spendUsd != null && (
          <div className="card p-3 mb-4">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-[11px] text-text-muted">Cost budget</span>
              <span className={`text-[12px] font-mono tabular-nums ${spendUsd / parseFloat(costBudgetUsd) >= 0.8 ? 'text-status-warning' : 'text-text-secondary'}`}>
                ${spendUsd.toFixed(2)} / ${parseFloat(costBudgetUsd).toFixed(2)}
              </span>
            </div>
            <div className="h-[3px] rounded-full bg-[rgba(255,245,230,0.06)] overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-500 ${spendUsd / parseFloat(costBudgetUsd) >= 0.8 ? 'bg-status-warning' : 'bg-status-success'}`}
                style={{ width: `${Math.min(100, (spendUsd / parseFloat(costBudgetUsd)) * 100).toFixed(1)}%` }}
              />
            </div>
            {spendUsd / parseFloat(costBudgetUsd) >= 0.8 && (
              <p className="text-[11px] text-status-warning mt-1">
                {Math.round((spendUsd / parseFloat(costBudgetUsd)) * 100)}% of budget used
              </p>
            )}
          </div>
        )}

        {/* Workspace + status row */}
        <div className="flex items-center gap-2 text-[12px] text-text-muted">
          {mission.workspace && !isSystemWorkspace(mission.workspace.name) && (
            <Link
              href={`/app/workspaces/${mission.workspace.id}`}
              className="text-accent-text hover:underline"
            >
              {displayWorkspaceName(mission.workspace.name)}
            </Link>
          )}
          {activeAgents > 0 && mission.status !== 'completed' && (
            <>
              {mission.workspace && !isSystemWorkspace(mission.workspace.name) && (
                <span className="text-text-muted">&middot;</span>
              )}
              <span className="text-status-info">{activeAgents} agent{activeAgents !== 1 ? 's' : ''} active</span>
            </>
          )}
          {mission.status === 'completed' && (
            <>
              {mission.workspace && !isSystemWorkspace(mission.workspace.name) && (
                <span className="text-text-muted">&middot;</span>
              )}
              <span>Completed {new Date(mission.updatedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</span>
            </>
          )}
        </div>

        {/* Initiative parent — always visible */}
        <div className="mt-2">
          <MissionInitiativeSelector
            missionId={id}
            currentInitiativeId={dbInitiative?.id ?? null}
            currentInitiativeName={dbInitiative?.title ?? null}
            initiatives={teamInitiativeOptions}
            readonly={isTerminal}
          />
        </div>

        {/* Completion Summary — only for completed missions */}
        {mission.status === 'completed' && (() => {
          // Priority: orchestrator (planning) summaries first, then work tasks.
          // Within each group, prefer non-reaper completions so the agent's own
          // retrospective wins over the reaper's artifact extraction.
          const candidateTasks = allTasks.filter(t => t.status === 'completed' && (t.result as any)?.summary);
          const planningWithSummary = candidateTasks
            .filter(t => t.mode === 'planning')
            .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
          const workWithSummary = candidateTasks
            .filter(t => t.mode !== 'planning')
            .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
          const bestTask =
            planningWithSummary.find(t => !(t.result as any)?.reaperAutoCompleted) ??
            workWithSummary.find(t => !(t.result as any)?.reaperAutoCompleted) ??
            planningWithSummary[0] ??
            workWithSummary[0];
          const summary = (bestTask?.result as any)?.summary as string | undefined;
          if (!summary) return null;
          const reaperAutoCompleted = (bestTask?.result as any)?.reaperAutoCompleted === true;
          return (
            <div className="card p-4 mt-4 border-l-2 border-status-success/40">
              <div className="flex items-center gap-2 mb-2">
                <h3 className="text-[10px] font-semibold tracking-wider text-text-muted uppercase">
                  Completion Summary
                </h3>
                {reaperAutoCompleted && (
                  <span className="font-mono text-[9px] uppercase tracking-wide border border-text-muted/40 text-text-muted px-1 py-px shrink-0">
                    auto-completed · reaper
                  </span>
                )}
              </div>
              <p className="text-[13px] text-text-secondary leading-relaxed">{summary}</p>
            </div>
          );
        })()}

        {/* Stats row — only for completed missions */}
        {mission.status === 'completed' && (() => {
          function fmtMin(min: number): string {
            const h = Math.floor(min / 60);
            const m = Math.round(min % 60);
            if (h === 0) return `${m}m`;
            if (m === 0) return `${h}h`;
            if (h >= 24) { const d = Math.floor(h / 24); return `${d}d ${h % 24}h`; }
            return `${h}h ${m}m`;
          }
          // Reuse the skyline computation from the mission card (do not re-derive).
          // agentTimeMin = Σ worker wall-clock spans; activeSpanMin = first-start → last-end.
          const skyline = computeMissionSkyline(allTasks);
          const agentLabel = skyline ? fmtMin(skyline.agentTimeMin) : null;
          const wallLabel = skyline ? fmtMin(skyline.activeSpanMin) : (() => {
            const ws = allTasks.flatMap((t: any) => t.workers ?? []);
            const starts = ws.map((w: any) => w.startedAt ? new Date(w.startedAt).getTime() : null).filter(Boolean) as number[];
            const ends = ws.map((w: any) => w.completedAt ? new Date(w.completedAt).getTime() : null).filter(Boolean) as number[];
            if (starts.length === 0 || ends.length === 0) {
              return fmtMin((new Date(mission.updatedAt).getTime() - new Date(mission.createdAt).getTime()) / 60_000);
            }
            return fmtMin((Math.max(...ends) - Math.min(...starts)) / 60_000);
          })();
          // Show wall-clock secondary only when it meaningfully differs from agent time (>1 min gap).
          const showWall = agentLabel && wallLabel && agentLabel !== wallLabel &&
            skyline && Math.abs(skyline.activeSpanMin - skyline.agentTimeMin) > 1;
          return (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-4">
              {[
                { label: 'Tasks', value: String(totalTasks) },
                { label: 'Completed', value: String(completedTasks) },
                { label: 'PRs', value: String(allTasks.flatMap(t => t.workers || []).filter(w => w.prUrl).length) },
              ].map(stat => (
                <div key={stat.label} className="card p-3">
                  <div className="text-[11px] md:text-[10px] text-text-muted uppercase tracking-wider">{stat.label}</div>
                  <div className="font-display text-lg text-text-primary mt-1">{stat.value}</div>
                </div>
              ))}
              <div className="card p-3">
                <div className="text-[11px] md:text-[10px] text-text-muted uppercase tracking-wider">Duration</div>
                <div className="font-display text-lg text-text-primary mt-1">{agentLabel ?? wallLabel ?? '—'}</div>
                {showWall && (
                  <div className="text-[10px] text-text-muted mt-0.5 font-mono">{wallLabel} wall</div>
                )}
              </div>
            </div>
          );
        })()}
      </div>

      {/* Review outcome summary — shown when mission is ready for human sign-off */}
      {displayState === 'review' && (
        <div className="mb-2">
          <MissionReviewSummary
            missionId={id}
            tasks={allTasks
              .filter(t => t.category !== 'review' && t.status !== 'cancelled')
              .map(t => {
                const w = (t.workers as any[])?.[0];
                return {
                  id: t.id,
                  title: t.title,
                  status: t.status,
                  prUrl: w?.prUrl ?? null,
                  prNumber: w?.prNumber ?? null,
                  prMerged: !!w?.mergedAt,
                  prClosed: w?.prLifecycleStatus === 'closed',
                };
              })}
          />
        </div>
      )}

      {/* Mission Controls & Quick Task */}
      <div className="mb-6">
        <MissionSettings
          missionId={id}
          currentStatus={mission.status}
          cronExpression={scheduleCron}
          workspaceId={mission.workspaceId}
          roles={roles}
          hasSchedule={!!scheduleCron}
          orchestrationMode={mission.orchestrationMode as 'auto' | 'manual' | undefined ?? 'auto'}
          isHeld={isHeld}
          displayState={displayState}
        />
      </div>

      {/* ── Timeline / Feed Tabs — PRIMARY CONTENT ── */}
      <MissionTabs
        timelineContent={(<CondensedTimeline
          groups={timelineGroups}
          segments={segments}
          effectivePolicyTier={effectivePolicy.tier}
          policyLabel={policyLabel}
          missionId={id}
          allTasksCount={allTasksCount}
          missionCompleted={mission.status === 'completed'}
          bookkeepingTasks={bookkeepingTasks}
          defaultView={defaultView}
          prsMerged={prsMerged}
          prsOpen={prsOpen}
          completedTasks={completedTasks}
          totalTasks={totalTasks}
        />)}
        feedContent={<MissionFeed missionId={id} />}
      />


      {/* ── Goal Criteria — shown when criteria are set (empty = no chrome) ── */}
      {(() => {
        const goalCriteria = (mission as any).goalCriteria as import('@buildd/shared').GoalCriterion[] | null;
        const goalCriteriaState = (mission as any).goalCriteriaState as import('@buildd/shared').GoalCriteriaState | null;
        const autoVerify = (mission as any).autoVerify as boolean | null;
        const criteria = goalCriteria ?? [];
        const isTerminalMission = ['completed', 'archived'].includes(mission.status);
        if (criteria.length === 0 && isTerminalMission) return null;
        return (
          <div className="mb-6">
            <MissionGoalCriteria
              missionId={id}
              criteria={criteria}
              criteriaState={goalCriteriaState}
              autoVerify={autoVerify}
              readonly={isTerminalMission}
            />
          </div>
        );
      })()}

      {/* ── Secondary: Settings (collapsed by default) ── */}
      {(isHeartbeat || !['completed', 'archived'].includes(mission.status)) && (
        <MissionSecondaryPanel configSummary={configSummary}>
          {/* Monitoring toggle — schedules only, moved from top-level chrome */}
          {scheduleCron && !['completed', 'archived'].includes(mission.status) && (
            <MissionMonitoringToggle
              missionId={id}
              initialStatus={mission.status}
              hasSchedule={!!scheduleCron}
              schedule={mission.schedule ? {
                nextRunAt: (mission.schedule as any).nextRunAt?.toISOString?.() || (mission.schedule as any).nextRunAt || null,
                lastRunAt: (mission.schedule as any).lastRunAt?.toISOString?.() || (mission.schedule as any).lastRunAt || null,
              } : null}
              orchestrationMode={orchestrationMode}
            />
          )}

          {/* Backend selector — moved from top-level chrome */}
          {!['completed', 'archived'].includes(mission.status) && (
            <div>
              <h2 className="section-label mb-2">Agent backend</h2>
              <MissionBackendSelector missionId={id} initialBackend={((mission as { defaultBackend?: 'claude' | 'codex' | null }).defaultBackend) ?? null} />
              <p className="text-[11px] text-text-muted mt-1.5">Default engine for tasks spawned by this mission. Auto inherits the role or workspace default.</p>
            </div>
          )}

          {/* Evaluation Log — heartbeat missions only, secondary content */}
          {isHeartbeat && heartbeatTasks.length > 0 && (
            <HeartbeatTimeline
              tasks={heartbeatTasks.map(t => ({
                id: t.id,
                createdAt: t.createdAt,
                status: t.status,
                result: t.result,
              }))}
            />
          )}

          {/* Heartbeat Checklist & Quiet Hours */}
          {isHeartbeat && (
            <>
              <HeartbeatChecklistEditor
                missionId={id}
                checklist={heartbeatChecklist}
              />
              <QuietHoursConfig
                missionId={id}
                activeHoursStart={activeHoursStart}
                activeHoursEnd={activeHoursEnd}
                activeHoursTimezone={activeHoursTimezone}
              />
            </>
          )}

          {/* Schedule Wizard */}
          {!scheduleCron && !['completed', 'archived'].includes(mission.status) && (
            <ScheduleWizard
              missionId={id}
              hasWorkspace={!!mission.workspaceId}
              workspaces={teamWorkspaces}
            />
          )}

          {/* Configuration — flattened into Settings, one tap away */}
          {!['completed', 'archived'].includes(mission.status) && (
            <div className="card p-4">
              <h2 className="section-label mb-4">Configuration</h2>
              <MissionConfig
                missionId={id}
                workspaceId={mission.workspaceId}
                model={configModel}
                workspaces={teamWorkspaces}
                maxConcurrentTasks={mission.maxConcurrentTasks}
                activeTasks={(mission.tasks || []).filter(t => ['pending', 'assigned', 'in_progress'].includes(t.status)).length}
                costBudgetUsd={costBudgetUsd}
              />
              {/* Merge policy row — inherit/override pattern */}
              {mission.workspaceId && (
                <div className="mt-4 pt-3 border-t border-border-default">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-[11px] text-text-muted uppercase tracking-wider font-semibold">Merge Policy</span>
                  </div>
                  <MissionMergePolicyRow
                    missionId={id}
                    missionTitle={mission.title}
                    roles={roles.map(r => ({ slug: r.slug, name: r.name }))}
                    missionPolicy={(mission as any).mergePolicy ?? null}
                    workspaceDefaultTier={workspaceDefaultPolicy.tier}
                    workspaceName={mission.workspace?.name ?? null}
                  />
                </div>
              )}
            </div>
          )}

          {/* Linear Phase 2 — read-back tracking (only when linked) */}
          {trackerLinks.some(l => l.provider === 'linear') && (
            <TrackerProgressPanel entityType="mission" entityId={id} />
          )}
        </MissionSecondaryPanel>
      )}

      {/* ── Artifacts ── */}
      <MissionArtifacts
        artifacts={allArtifacts.map((a) => ({
          id: a.id,
          type: a.type,
          title: a.title ?? a.key ?? null,
          content: a.content ?? null,
          shareToken: a.shareToken ?? null,
          visibility: (a.visibility as 'private' | 'public') ?? 'private',
          metadata: (a.metadata as Record<string, unknown>) ?? {},
          createdAt: String(a.createdAt),
          taskTitle: a.taskTitle ?? null,
        }))}
        baseUrl={baseUrl}
        missionId={id}
        initialOpenArtifactId={initialOpenArtifactId}
      />

    </div>
    </TaskPanelWrapper>
    </SwipeProvider>
  );
}
