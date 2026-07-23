import { db } from '@buildd/core/db';
import { missions, workspaces, workspaceSkills, missionNotes, workers, tasks } from '@buildd/core/db/schema';
import { eq, and, inArray, desc, isNotNull, isNull } from 'drizzle-orm';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth-helpers';
import { getUserTeamIds, getUserWorkspaceIds } from '@/lib/team-access';
import { deriveMissionHealth, deriveHealth, formatNextRun, timeAgo } from '@/lib/mission-helpers';
import { computeMissionProgress } from '@buildd/core/mission-helpers';
import { MissionBadges, MissionProgress } from '@/components/MissionProgress';
import TaskCard from '@/components/TaskCard';
import { deriveChainPosition, type ChainPositionResult } from '@/lib/task-presentation';
import { getHeartbeatStatus, isOverdue as checkOverdue } from '@/lib/heartbeat-helpers';
import { isSystemWorkspace, displayWorkspaceName } from '@buildd/shared';
import WorkerRespondInput from '@/components/WorkerRespondInput';
import ExternalLink from '@/components/ExternalLink';
import MergeConfirmButton from '@/components/MergeConfirmButton';
import { resolvePolicy } from '@/lib/merge-policy';
import MissionSettings from './MissionSettings';
import MissionInlineEdit from './MissionInlineEdit';
import MissionAutoRefresh from './MissionAutoRefresh';
import ExpandableText from './ExpandableText';
import TaskPanelWrapper from './TaskPanelWrapper';
import InlineTaskRetry from './InlineTaskRetry';
import HeartbeatStatusBadge from './HeartbeatStatusBadge';
import HeartbeatChecklistEditor from './HeartbeatChecklistEditor';
import QuietHoursConfig from './QuietHoursConfig';
import HeartbeatTimeline from './HeartbeatTimeline';
import AiFeedback from '@/components/AiFeedback';
import { StatusChip } from '@/components/StatusChip';
import PrioritySelector from './PrioritySelector';
import MissionBackendSelector from './MissionBackendSelector';
import ScheduleWizard from './ScheduleWizard';
import MissionConfig from './MissionConfig';
import MissionTabs from './MissionTabs';
import MissionFeed from './MissionFeed';
import MissionSecondaryPanel from './MissionSecondaryPanel';
import RaiseBudgetButton from './RaiseBudgetButton';
import { getMissionSpendUsd } from '@/lib/mission-budget';

export const dynamic = 'force-dynamic';


export default async function MissionDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user = await getCurrentUser();
  if (!user) redirect('/app/auth/signin');

  const teamIds = await getUserTeamIds(user.id);

  const mission = await db.query.missions.findFirst({
    where: eq(missions.id, id),
    with: {
      workspace: { columns: { id: true, name: true } },
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
                columns: { id: true, type: true, title: true, key: true, shareToken: true },
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
        columns: { taskId: true, type: true, title: true, body: true, createdAt: true },
        orderBy: desc(missionNotes.createdAt),
      })
    : [];

  // Map taskId → latest reviewer note
  const reviewerNoteMap = new Map<string, { type: string; title: string; body: string | null; createdAt: Date }>();
  for (const note of reviewerNotes) {
    if (note.taskId && !reviewerNoteMap.has(note.taskId)) {
      reviewerNoteMap.set(note.taskId, note);
    }
  }

  // BT-13: count tasks awaiting merge (completed + has PR + not yet merged)
  const awaitingMerge = (mission.tasks || []).filter(t => {
    if (t.status !== 'completed') return false;
    const latestWorker = (t.workers as any[])?.[0];
    return latestWorker?.prUrl && !latestWorker?.mergedAt;
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
  const policyTierLabel: Record<string, string> = {
    'auto-threshold': 'Auto',
    'agent-review': 'Agent Review',
    'human': 'Human Gate',
  };
  const policyLabel = policyTierLabel[effectivePolicy.tier] ?? effectivePolicy.tier;

  // Raw count for "View all N tasks" links — includes housekeeping and cancelled
  const allTasksCount = mission.tasks?.length || 0;
  // Progress uses deliverable non-cancelled tasks only so cancelled duplicates
  // don't inflate the denominator and block the mission from reaching 100%.
  const { totalTasks, completedTasks, progress: progressPct, segments } = computeMissionProgress(mission.tasks || []);
  // Completed missions always show 100% regardless of individual task outcomes.
  const progress = mission.status === 'completed' ? 100 : progressPct;

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
  const healthState = deriveHealth(mission, mission.tasks || []);

  // Orchestration mode
  const orchestrationMode = (mission.orchestrationMode as 'auto' | 'manual') ?? 'auto';
  const isManualMode = orchestrationMode === 'manual';
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

  // Heartbeat status
  const { lastStatus: lastHeartbeatStatus, lastAt: lastHeartbeatAt } = getHeartbeatStatus(
    (mission.tasks || []).map(t => ({
      id: t.id,
      createdAt: t.createdAt,
      status: t.status,
      result: t.result,
    }))
  );
  const heartbeatOverdue = isHeartbeat && mission.schedule?.nextRunAt && scheduleCron
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
      const depW = (dep.workers as Array<{ prUrl?: string | null; prNumber?: number | null; mergedAt?: Date | string | null }> | null)?.[0];
      return {
        id: dep.id,
        title: dep.title,
        status: dep.status,
        workers: depW ? [{ prUrl: depW.prUrl ?? null, prNumber: depW.prNumber ?? null, mergedAt: depW.mergedAt ? String(depW.mergedAt) : null }] : [],
      };
    }).filter(Boolean) as Array<{ id: string; title: string; status: string; workers: Array<{ prUrl: string | null; prNumber: number | null; mergedAt: string | null }> }>;
    const dependents = allTasks.filter(t => ((t.dependsOn as string[] | null) ?? []).includes(task.id)).length;
    chainByTaskId.set(task.id, deriveChainPosition({ task: { id: task.id, status: task.status }, deps, dependents }));
  }

  type TimelineCycle = {
    evaluation: typeof allTasks[0] | null;
    tasks: typeof allTasks;
  };

  const cycles: TimelineCycle[] = [];
  let currentCycle: TimelineCycle = { evaluation: null, tasks: [] };

  for (const task of allTasks) {
    if (task.mode === 'planning') {
      // Start a new cycle
      if (currentCycle.evaluation || currentCycle.tasks.length > 0) {
        cycles.push(currentCycle);
      }
      currentCycle = { evaluation: task, tasks: [] };
    } else {
      currentCycle.tasks.push(task);
    }
  }
  if (currentCycle.evaluation || currentCycle.tasks.length > 0) {
    cycles.push(currentCycle);
  }

  // Show newest first
  cycles.reverse();

  // Filter out empty cycles (planning tasks that spawned no work and have no summary)
  const filteredCycles = cycles.filter(cycle => {
    if (cycle.tasks.length > 0) return true;
    if (cycle.evaluation) {
      const result = cycle.evaluation.result as { summary?: string } | null;
      const isRunning = cycle.evaluation.status !== 'completed' && cycle.evaluation.status !== 'failed';
      return !!result?.summary || isRunning;
    }
    return false;
  });

  // For completed missions, show only the last 3 cycles
  const displayCycles = mission.status === 'completed'
    ? filteredCycles.slice(0, 3)
    : filteredCycles;

  // Collect all artifacts
  const allArtifacts = mission.tasks?.flatMap((t) =>
    t.workers?.flatMap((w) =>
      (w.artifacts || []).map((a) => ({ ...a, taskTitle: t.title, workerStatus: w.status }))
    ) || []
  ) || [];

  const missionTaskIds = allTasks.map((t) => t.id);

  return (
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

      {/* Breadcrumbs */}
      <div className="flex items-center gap-2 text-[12px] text-text-muted mb-5">
        <Link href="/app/missions" className="hover:text-text-secondary transition-colors">
          Missions
        </Link>
        <span>/</span>
        <span className="text-text-secondary truncate">{mission.title}</span>
      </div>

      {/* ── Status Block ── */}
      <div className="mb-6">
        <MissionInlineEdit
          missionId={id}
          initialTitle={mission.title}
          initialDescription={mission.description}
          healthPill={
            <span className="flex items-center gap-2 flex-wrap">
              <MissionBadges mission={{ ...mission, lastDeferralReason: (mission.schedule as any)?.lastDeferralReason, lastDeferredAt: (mission.schedule as any)?.lastDeferredAt }} health={healthState} nextRun={driveNextRun} />
              {isHeartbeat && (
                <HeartbeatStatusBadge
                  lastStatus={lastHeartbeatStatus}
                  lastAt={lastHeartbeatAt}
                  isOverdue={heartbeatOverdue}
                />
              )}
              {/* BT-21: Policy chip on mission header */}
              {mission.workspaceId && (
                <Link
                  href={`/app/settings/workspace/${mission.workspaceId}`}
                  className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono bg-surface-3 text-text-muted hover:text-text-secondary hover:bg-surface-2 transition-colors"
                  title={`Merge policy: ${policyLabel}`}
                >
                  <svg className="w-2.5 h-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M12 5v14m-7-7l7 7 7-7" />
                  </svg>
                  {policyLabel}
                </Link>
              )}
            </span>
          }
        />

        {/* Priority + default backend */}
        <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2">
          <PrioritySelector missionId={id} initialPriority={mission.priority} />
          <MissionBackendSelector missionId={id} initialBackend={((mission as { defaultBackend?: 'claude' | 'codex' | null }).defaultBackend) ?? null} />
        </div>

        {/* Progress — shown for all missions with tasks */}
        {totalTasks > 0 && (
          <div className="card p-4 mb-4">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[13px] text-text-secondary">Progress</span>
              <span className="font-display text-lg text-status-success tabular-nums">
                {progress}%
              </span>
            </div>
            <MissionProgress missionId={id} segments={segments} completedTasks={completedTasks} totalTasks={totalTasks} inFlightTasks={inFlightTasks} />
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

        {/* Completion Summary — only for completed missions */}
        {mission.status === 'completed' && (() => {
          const lastPlanningTask = allTasks
            .filter(t => t.mode === 'planning' && t.status === 'completed')
            .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];
          const summary = (lastPlanningTask?.result as any)?.summary;
          if (!summary) return null;
          return (
            <div className="card p-4 mt-4 border-l-2 border-status-success/40">
              <h3 className="text-[10px] font-semibold tracking-wider text-text-muted uppercase mb-2">
                Completion Summary
              </h3>
              <p className="text-[13px] text-text-secondary leading-relaxed">{summary}</p>
            </div>
          );
        })()}

        {/* Stats row — only for completed missions */}
        {mission.status === 'completed' && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-4">
            {[
              { label: 'Tasks', value: String(totalTasks) },
              { label: 'Completed', value: String(completedTasks) },
              { label: 'PRs', value: String(allTasks.flatMap(t => t.workers || []).filter(w => w.prUrl).length) },
              { label: 'Duration', value: (() => {
                const ms = new Date(mission.updatedAt).getTime() - new Date(mission.createdAt).getTime();
                const hours = Math.floor(ms / 3600000);
                const minutes = Math.floor((ms % 3600000) / 60000);
                if (hours > 24) {
                  const days = Math.floor(hours / 24);
                  return `${days}d ${hours % 24}h`;
                }
                return `${hours}h ${minutes}m`;
              })() },
            ].map(stat => (
              <div key={stat.label} className="card p-3">
                <div className="text-[11px] md:text-[10px] text-text-muted uppercase tracking-wider">{stat.label}</div>
                <div className="font-display text-lg text-text-primary mt-1">{stat.value}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Mission Controls & Quick Task */}
      <div className="mb-6">
        <MissionSettings
          missionId={id}
          currentStatus={mission.status}
          cronExpression={scheduleCron}
          workspaceId={mission.workspaceId}
          roles={roles}
          schedule={mission.schedule ? {
            nextRunAt: (mission.schedule as any).nextRunAt?.toISOString?.() || (mission.schedule as any).nextRunAt || null,
            lastRunAt: (mission.schedule as any).lastRunAt?.toISOString?.() || (mission.schedule as any).lastRunAt || null,
          } : null}
          hasSchedule={!!scheduleCron}
          orchestrationMode={mission.orchestrationMode as 'auto' | 'manual' | undefined ?? 'auto'}
        />
      </div>

      {/* ── Timeline / Feed Tabs — PRIMARY CONTENT ── */}
      <MissionTabs
        timelineContent={displayCycles.length > 0 ? (<>
        <div className="mb-6">
          <div className="flex items-center justify-between mb-3">
            <h2 className="section-label">Timeline</h2>
            {mission.status === 'completed' && allTasksCount > 0 && (
              <Link
                href={`/app/tasks?mission=${id}`}
                className="text-[12px] text-accent-text hover:underline"
              >
                View all {allTasksCount} tasks &rarr;
              </Link>
            )}
          </div>
          <div className="relative">
            {displayCycles.map((cycle, ci) => {
              const isLast = ci === displayCycles.length - 1;
              const evalResult = cycle.evaluation?.result as { summary?: string; structuredOutput?: Record<string, unknown> } | null;
              const triageOutcome = evalResult?.structuredOutput?.triageOutcome as string | undefined;
              const evalWorker = cycle.evaluation?.workers?.[0];
              const evalIsRunning = evalWorker?.status === 'running' || (cycle.evaluation?.status === 'running');
              const evalElapsed = evalWorker?.startedAt
                ? Math.round((Date.now() - new Date(evalWorker.startedAt).getTime()) / 1000)
                : null;

              return (
                <div key={cycle.evaluation?.id || `cycle-${ci}`} className={`flex gap-0 ${ci === 0 ? 'animate-card-enter' : ''}`}>
                  {/* Spine */}
                  <div className="flex flex-col items-center w-8 shrink-0">
                    {cycle.evaluation ? (
                      <span className={`shrink-0 mt-0.5 ${
                        evalIsRunning
                          ? 'w-3 h-3 rounded-full bg-status-info animate-status-pulse'
                          : isHeartbeat
                            ? 'w-2.5 h-2.5 rounded-sm bg-[#059669]'
                            : 'w-3 h-3 rounded-full bg-[#D97706]'
                      }`} />
                    ) : (
                      <span className="w-3 h-3 rounded-full bg-text-muted shrink-0 mt-0.5" />
                    )}
                    {!isLast && (
                      <div className="w-0.5 flex-1 bg-border-default min-h-[16px]" />
                    )}
                  </div>

                  {/* Content */}
                  <div className="flex-1 pb-5 min-w-0">
                    {/* Evaluation header */}
                    {cycle.evaluation && (
                      <div className="mb-2">
                        <div className="flex items-center justify-between">
                          <span className="flex items-center gap-1.5">
                            <span className={`text-[12px] font-semibold ${evalIsRunning ? 'text-status-info' : isHeartbeat ? 'text-[#059669]' : 'text-[#92400E]'}`}>
                              {evalIsRunning
                                ? (isHeartbeat ? 'Evaluating...' : 'Orchestrating...')
                                : (isHeartbeat ? 'Evaluated' : 'Orchestrated')}
                            </span>
                            {evalIsRunning && (
                              <span className="w-1.5 h-1.5 rounded-full bg-status-info animate-status-pulse" />
                            )}
                            {!evalIsRunning && triageOutcome && (() => {
                              const badge = {
                                single_task: { label: 'Routed', cls: 'bg-emerald-500/10 text-emerald-600' },
                                multi_task: { label: 'Decomposed', cls: 'bg-blue-500/10 text-blue-600' },
                                conflict: { label: 'Conflict', cls: 'bg-amber-500/10 text-amber-600' },
                              }[triageOutcome];
                              if (!badge) return null;
                              return <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${badge.cls}`}>{badge.label}</span>;
                            })()}
                          </span>
                          <span className="text-[11px] text-text-muted tabular-nums">
                            {evalIsRunning
                              ? evalElapsed != null
                                ? evalElapsed < 60
                                  ? `${evalElapsed}s`
                                  : `${Math.floor(evalElapsed / 60)}m ${evalElapsed % 60}s`
                                : 'Starting...'
                              : timeAgo(cycle.evaluation.createdAt)}
                          </span>
                        </div>

                        {/* Live orchestrator activity */}
                        {evalIsRunning && evalWorker && (
                          <div className="mt-1.5 flex items-start gap-2">
                            {evalWorker.currentAction && (
                              <p className="text-[12px] text-text-secondary leading-relaxed flex-1">
                                {evalWorker.currentAction}
                              </p>
                            )}
                            {(evalWorker.turns ?? 0) > 0 && (
                              <span className="text-[11px] text-text-muted tabular-nums shrink-0">
                                {evalWorker.turns} turn{evalWorker.turns !== 1 ? 's' : ''}
                              </span>
                            )}
                          </div>
                        )}

                        {evalResult?.summary && (
                          <>
                            {triageOutcome === 'conflict'
                              ? <p className="text-[12px] text-text-secondary mt-1.5 leading-relaxed">{evalResult.summary}</p>
                              : <ExpandableText text={evalResult.summary} />
                            }
                            <div className="mt-1">
                              <AiFeedback entityType="orchestration" entityId={`eval-${cycle.evaluation?.id}`} compact />
                            </div>
                          </>
                        )}
                      </div>
                    )}

                    {/* Task branches */}
                    {cycle.tasks.length > 0 && (
                      <div className="space-y-0.5">
                        {cycle.tasks.map((task, ti) => {
                          const role = task.roleSlug ? rolesMap.get(task.roleSlug) : null;
                          const roleColor = role?.color || '#8A8478';
                          const taskResult = task.result as { summary?: string; nextSuggestion?: string } | null;
                          const latestWorker = task.workers?.[0];
                          const isRunning = latestWorker?.status === 'running';
                          const isDone = task.status === 'completed';
                          const isFailed = task.status === 'failed';
                          const waitingWorker = task.workers?.find(
                            (w) => w.status === 'waiting_input' && w.waitingFor
                          );
                          const waitingFor = waitingWorker?.waitingFor as {
                            type: string;
                            prompt: string;
                            options?: string[];
                          } | null;

                          return (
                            <div key={task.id} className="animate-timeline-enter" style={{ animationDelay: `${ti * 60}ms` }}>
                              {/* Task row — branch connector + role dot + TaskCard.
                                  data-task-id on the wrapper so TaskPanelWrapper.closest()
                                  can intercept the click even though the Link is inside TaskCard. */}
                              <div
                                data-task-id={task.id}
                                data-task-actionable={(!isDone || !!latestWorker?.prUrl) ? 'true' : 'false'}
                                className="flex items-center gap-0"
                              >
                                <span className="flex items-center gap-1.5 shrink-0 w-5 pointer-events-none" aria-hidden="true">
                                  <span className="w-2 h-px bg-border-default" />
                                  <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: roleColor }} />
                                </span>
                                <div className="flex-1 min-w-0">
                                  <TaskCard
                                    density="inline"
                                    id={task.id}
                                    title={task.title}
                                    taskStatus={task.status}
                                    workerStatus={latestWorker?.status ?? null}
                                    chain={chainByTaskId.get(task.id) ?? null}
                                    taskCreatedAt={task.createdAt.toISOString()}
                                    taskUpdatedAt={task.updatedAt.toISOString()}
                                    workerStartedAt={latestWorker?.startedAt ? latestWorker.startedAt.toISOString() : null}
                                    workerUpdatedAt={null}
                                    prUrl={latestWorker?.prUrl ?? null}
                                    prNumber={latestWorker?.prNumber ?? null}
                                    prLifecycleStatus={latestWorker?.prLifecycleStatus ?? null}
                                    currentAction={latestWorker?.currentAction ?? null}
                                  />
                                  {/* BT-14: tier badge + wait duration on awaiting-merge rows */}
                                  {isDone && latestWorker?.prUrl && !latestWorker?.mergedAt && (() => {
                                    const waitMins = latestWorker.completedAt
                                      ? Math.floor((Date.now() - new Date(latestWorker.completedAt).getTime()) / 60000)
                                      : 0;
                                    return (
                                      <div className="px-2 pb-1">
                                        <StatusChip
                                          policyTier={effectivePolicy.tier}
                                          waitingMinutes={waitMins}
                                          className="hidden sm:inline-flex"
                                        />
                                      </div>
                                    );
                                  })()}
                                </div>
                              </div>

                              {/* InlineTaskRetry for failed tasks */}
                              {isFailed && (
                                <div className="pl-5 pb-1">
                                  <InlineTaskRetry taskId={task.id} />
                                </div>
                              )}

                              {waitingWorker && waitingFor && (
                                <div className="pl-7 pb-1">
                                  <span className="section-label text-status-warning">Needs your input</span>
                                  <WorkerRespondInput
                                    workerId={waitingWorker.id}
                                    question={waitingFor.prompt}
                                    options={waitingFor.options}
                                  />
                                </div>
                              )}

                              {isDone && taskResult?.nextSuggestion && (
                                <div className="pl-7 pb-0.5">
                                  <p className="text-[11px] text-text-muted italic leading-relaxed">
                                    <span className="text-text-secondary">Suggested:</span>{' '}
                                    &ldquo;{taskResult.nextSuggestion}&rdquo;
                                  </p>
                                </div>
                              )}

                              {/* BT-16: Agent-review verdict chips */}
                              {(() => {
                                const reviewNote = reviewerNoteMap.get(task.id);
                                if (!reviewNote) return null;
                                const noteType = reviewNote.type;

                                if (noteType === 'reviewer_approved') {
                                  return (
                                    <div className="pl-7 pb-1 mt-1">
                                      <div className="flex items-start gap-2 bg-status-success/5 border border-status-success/20 rounded px-2.5 py-1.5">
                                        <span className="text-status-success text-[11px] font-semibold shrink-0">🤖 Approved</span>
                                        <span className="text-[11px] text-text-secondary leading-relaxed">{reviewNote.body ?? reviewNote.title}</span>
                                      </div>
                                    </div>
                                  );
                                }

                                if (noteType === 'reviewer_request_changes') {
                                  return (
                                    <div className="pl-7 pb-1 mt-1">
                                      <div className="bg-[#D97706]/5 border border-[#D97706]/20 rounded px-2.5 py-1.5">
                                        <div className="flex items-center gap-1.5 mb-0.5">
                                          <span className="text-[#D97706] text-[11px] font-semibold">🤖 Changes Requested</span>
                                        </div>
                                        <p className="text-[11px] text-text-secondary leading-relaxed">{reviewNote.body ?? reviewNote.title}</p>
                                      </div>
                                    </div>
                                  );
                                }

                                if (noteType === 'reviewer_escalated') {
                                  const prWorker = latestWorker;
                                  return (
                                    <div className="pl-7 pb-1 mt-1">
                                      <div className="bg-status-error/5 border border-status-error/20 rounded px-2.5 py-2">
                                        <div className="flex items-center gap-1.5 mb-1">
                                          <span className="text-status-error text-[11px] font-semibold">🤖 Escalated to you</span>
                                        </div>
                                        <p className="text-[11px] text-text-secondary leading-relaxed mb-2">{reviewNote.body ?? reviewNote.title}</p>
                                        <div className="flex items-center gap-2 flex-wrap">
                                          {prWorker?.prUrl && (
                                            <ExternalLink
                                              href={prWorker.prUrl}
                                              className="text-[11px] text-accent-text hover:underline"
                                            >
                                              PR #{prWorker.prNumber} ↗
                                            </ExternalLink>
                                          )}
                                          {prWorker?.prNumber && !prWorker?.mergedAt && (
                                            <MergeConfirmButton
                                              prNumber={prWorker.prNumber}
                                              prUrl={prWorker.prUrl ?? ''}
                                            />
                                          )}
                                        </div>
                                      </div>
                                    </div>
                                  );
                                }

                                return null;
                              })()}
                            </div>
                          );
                        })}
                      </div>
                    )}

                    {/* BT-18: Gate chip — PRs awaiting merge in this cycle */}
                    {(() => {
                      const awaitingPrs = cycle.tasks
                        .filter(t => t.status === 'completed')
                        .map(t => ({ task: t, worker: (t.workers as any[])?.[0] }))
                        .filter(({ worker }) => worker?.prUrl && !worker?.mergedAt);
                      if (awaitingPrs.length === 0) return null;
                      return (
                        <div className="mt-2 mb-1 ml-7 border border-border-strong rounded-[8px] px-3 py-2.5 bg-surface-2">
                          <div className="flex items-center gap-2 mb-2">
                            <span className="text-[11px] font-semibold text-text-secondary">
                              ⏸ {awaitingPrs.length} PR{awaitingPrs.length > 1 ? 's' : ''} awaiting merge
                            </span>
                            <span className="text-[10px] font-mono text-text-muted bg-surface-3 px-1.5 py-0.5 rounded">
                              {policyLabel}
                            </span>
                          </div>
                          <div className="space-y-1.5">
                            {awaitingPrs.map(({ task: t, worker: w }) => {
                              const reviewNote = reviewerNoteMap.get(t.id);
                              const reviewStatus = reviewNote?.type === 'reviewer_approved'
                                ? '✓ Approved'
                                : reviewNote?.type === 'reviewer_request_changes'
                                  ? '↩ Changes requested'
                                  : reviewNote?.type === 'reviewer_escalated'
                                    ? '⚠ Escalated'
                                    : effectivePolicy.tier === 'agent-review'
                                      ? '🤖 Auto-reviewing…'
                                      : null;
                              return (
                                <div key={t.id} className="flex items-center justify-between gap-2 text-[11px]">
                                  <div className="flex items-center gap-2 min-w-0">
                                    {w.prUrl && (
                                      <ExternalLink href={w.prUrl} className="text-accent-text hover:underline shrink-0">
                                        PR #{w.prNumber}
                                      </ExternalLink>
                                    )}
                                    {reviewStatus && (
                                      <span className="text-text-muted truncate">{reviewStatus}</span>
                                    )}
                                  </div>
                                  {w.prNumber && !w.mergedAt && (
                                    <MergeConfirmButton
                                      prNumber={w.prNumber}
                                      prUrl={w.prUrl ?? ''}
                                      className="shrink-0"
                                      disabled={effectivePolicy.tier === 'agent-review' && !reviewNote}
                                      disabledReason="Awaiting agent review"
                                    />
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })()}

                    {/* No tasks spawned */}
                    {cycle.evaluation && cycle.tasks.length === 0 && (
                      <p className="text-[12px] text-text-muted italic">No tasks needed</p>
                    )}
                  </div>
                </div>
              );
            })}

            {/* Next evaluation indicator — hidden for completed missions */}
            {scheduleCron && mission.status !== 'completed' && (
              <div className="flex gap-0 items-center">
                <div className="flex flex-col items-center w-8 shrink-0">
                  <span className={`w-3 h-3 rounded-full border-2 shrink-0 ${isManualMode ? 'border-amber-500/40 bg-transparent' : 'border-border-default bg-transparent'}`} />
                </div>
                {isManualMode ? (
                  <span className="text-[12px] text-amber-600 italic pl-2">Disarmed · Run now to advance</span>
                ) : mission.status === 'paused' ? (
                  <span className="text-[12px] text-text-muted italic pl-2">Monitoring paused</span>
                ) : scheduleOverdue ? (
                  <span className="text-[12px] text-status-warning italic pl-2">Overdue by {scheduleOverdueMinutes}m</span>
                ) : scheduleNextRunAt ? (
                  <span className="text-[12px] text-text-muted italic pl-2">Next evaluation {timeAgo(scheduleNextRunAt)}</span>
                ) : null}
              </div>
            )}
          </div>
        </div>

      {/* View all tasks link — hidden for completed missions (shown in timeline header instead) */}
      {allTasksCount > 0 && mission.status !== 'completed' && (
        <div className="mb-6">
          <Link
            href={`/app/tasks?mission=${id}`}
            className="flex items-center gap-2 px-3 py-2.5 rounded-lg hover:bg-card-hover transition-colors group text-[13px] text-text-secondary hover:text-accent-text"
          >
            <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 6.75h12M8.25 12h12m-12 5.25h12M3.75 6.75h.007v.008H3.75V6.75zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zM3.75 12h.007v.008H3.75V12zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm-.375 5.25h.007v.008H3.75v-.008zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0z" />
            </svg>
            <span>View all {allTasksCount} tasks</span>
            <svg className="w-3.5 h-3.5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
            </svg>
          </Link>
        </div>
      )}
        </>) : <p className="text-[13px] text-text-muted italic mb-6">No tasks yet</p>}
        feedContent={<MissionFeed missionId={id} />}
      />

      {/* ── Secondary: Settings (collapsed by default) ── */}
      {(isHeartbeat || !['completed', 'archived'].includes(mission.status)) && (
        <MissionSecondaryPanel>
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

          {/* Configuration */}
          {!['completed', 'archived'].includes(mission.status) && (
            <MissionConfig
              missionId={id}
              workspaceId={mission.workspaceId}
              model={configModel}
              workspaces={teamWorkspaces}
              maxConcurrentTasks={mission.maxConcurrentTasks}
              activeTasks={(mission.tasks || []).filter(t => ['pending', 'assigned', 'in_progress'].includes(t.status)).length}
              costBudgetUsd={costBudgetUsd}
            />
          )}
        </MissionSecondaryPanel>
      )}

      {/* ── Artifacts ── */}
      {allArtifacts.length > 0 && (
        <div className="mb-6">
          <h2 className="section-label mb-3">Artifacts ({allArtifacts.length})</h2>
          <div className="space-y-1.5">
            {allArtifacts.map((a) => (
              <div
                key={a.id}
                className="flex items-center gap-3 px-3 py-2.5 rounded-lg bg-card border border-card-border"
              >
                <svg className="w-4 h-4 text-text-muted shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
                </svg>
                <div className="flex-1 min-w-0">
                  <span className="text-[13px] text-text-primary truncate block">
                    {a.title || a.key || 'Untitled'}
                  </span>
                  <span className="text-[11px] text-text-muted">
                    {a.type} &middot; {a.taskTitle}
                  </span>
                </div>
                <Link
                  href={`/app/missions/new?artifactId=${a.id}&artifactTitle=${encodeURIComponent(a.title || a.key || 'Untitled')}&sourceMission=${encodeURIComponent(mission.title)}`}
                  className="text-[11px] text-text-muted hover:text-accent-text transition-colors shrink-0"
                  title="New mission from this artifact"
                >
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.27 20.876L5.999 12zm0 0h7.5" />
                  </svg>
                </Link>
                {a.shareToken && (
                  <a
                    href={`/share/${a.shareToken}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[11px] text-accent-text hover:underline shrink-0"
                  >
                    View
                  </a>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

    </div>
    </TaskPanelWrapper>
  );
}
