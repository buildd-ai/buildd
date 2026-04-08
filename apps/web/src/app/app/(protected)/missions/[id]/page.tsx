import { db } from '@buildd/core/db';
import { missions, workspaces, workspaceSkills } from '@buildd/core/db/schema';
import { eq, and, inArray, desc } from 'drizzle-orm';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth-helpers';
import { getUserTeamIds, getUserWorkspaceIds } from '@/lib/team-access';
import { deriveMissionHealth, HEALTH_DISPLAY, timeAgo } from '@/lib/mission-helpers';
import { getHeartbeatStatus, isOverdue as checkOverdue } from '@/lib/heartbeat-helpers';
import { isSystemWorkspace, displayWorkspaceName } from '@buildd/shared';
import WorkerRespondInput from '@/components/WorkerRespondInput';
import MissionSettings from './MissionSettings';
import MissionInlineEdit from './MissionInlineEdit';
import MissionAutoRefresh from './MissionAutoRefresh';
import ExpandableText from './ExpandableText';
import TaskPanelWrapper from './TaskPanelWrapper';
import HeartbeatStatusBadge from './HeartbeatStatusBadge';
import HeartbeatChecklistEditor from './HeartbeatChecklistEditor';
import ActiveHoursConfig from './ActiveHoursConfig';
import HeartbeatTimeline from './HeartbeatTimeline';
import PrioritySelector from './PrioritySelector';
import ScheduleWizard from './ScheduleWizard';
import MissionConfig from './MissionConfig';

export const dynamic = 'force-dynamic';

const STATUS_DOT: Record<string, string> = {
  pending: 'bg-text-muted',
  queued: 'bg-status-info',
  running: 'bg-status-running animate-status-pulse',
  waiting_input: 'bg-status-warning animate-status-pulse',
  completed: 'bg-status-success',
  failed: 'bg-status-error',
};

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
          result: true,
          mode: true,
          roleSlug: true,
          creationSource: true,
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

  const totalTasks = mission.tasks?.length || 0;
  const completedTasks = mission.tasks?.filter((t) => t.status === 'completed').length || 0;
  const failedTaskCount = mission.tasks?.filter((t) => t.status === 'failed').length || 0;
  // Completed missions show 100% — the mission is done regardless of individual task outcomes
  const progress = mission.status === 'completed'
    ? 100
    : totalTasks > 0
      ? Math.round((completedTasks / totalTasks) * 100)
      : 0;

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
  const healthDisplay = HEALTH_DISPLAY[health];

  // Heartbeat data — derived from schedule's taskTemplate.context
  const templateContext = (mission.schedule as any)?.taskTemplate?.context as Record<string, unknown> | undefined;
  const isHeartbeat = (templateContext?.heartbeat === true) || false;
  const heartbeatChecklist = (templateContext?.heartbeatChecklist as string) ?? null;
  const activeHoursStart = (templateContext?.activeHoursStart as number) ?? null;
  const activeHoursEnd = (templateContext?.activeHoursEnd as number) ?? null;
  const activeHoursTimezone = (templateContext?.activeHoursTimezone as string) ?? null;

  // Configuration from schedule template
  const skillSlugs = (templateContext?.skillSlugs as string[]) || [];
  const recipeId = (templateContext?.recipeId as string) || null;
  const configModel = (templateContext?.model as string) || null;
  const outputSchema = (templateContext?.outputSchema as unknown) || null;

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
  const heartbeatTasks = isHeartbeat
    ? (mission.tasks || []).filter(t => t.status === 'completed' || t.status === 'failed')
    : [];

  // Build roles map for color lookup
  const rolesMap = new Map<string, { name: string; color: string }>();
  roles.forEach((r) => rolesMap.set(r.slug, { name: r.name, color: r.color }));

  // Build orchestration timeline: group tasks into cycles
  // Planning tasks = evaluation nodes, execution tasks = branches
  const allTasks = (mission.tasks || []).slice().sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
  );

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
    <div className="px-7 md:px-10 pt-5 md:pt-8 pb-12 max-w-3xl">
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
              <span className={`health-pill ${healthDisplay.colorClass}`}>
                {healthDisplay.label}
              </span>
              {isHeartbeat && (
                <HeartbeatStatusBadge
                  lastStatus={lastHeartbeatStatus}
                  lastAt={lastHeartbeatAt}
                  isOverdue={heartbeatOverdue}
                />
              )}
            </span>
          }
        />

        {/* Priority */}
        <div className="mb-3">
          <PrioritySelector missionId={id} initialPriority={mission.priority} />
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
            <div className="h-[3px] rounded-full bg-[rgba(255,245,230,0.06)] overflow-hidden">
              <div
                className="h-full rounded-full transition-all duration-500"
                style={{
                  width: `${progress}%`,
                  background: 'linear-gradient(90deg, var(--status-success), #7ad4aa)',
                }}
              />
            </div>
            <div className="text-[11px] text-text-muted mt-1.5">
              {mission.status === 'completed'
                ? `${totalTasks} tasks · ${completedTasks} completed`
                : `${completedTasks} of ${totalTasks} tasks complete`}
            </div>
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
          <div className="grid grid-cols-4 gap-3 mt-4">
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
                <div className="text-[10px] text-text-muted uppercase tracking-wider">{stat.label}</div>
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
          failedTaskCount={failedTaskCount}
        />
      </div>

      {/* ── Heartbeat Section (heartbeat missions only) ── */}
      {isHeartbeat && (
        <div className="mb-6 space-y-4">
          <HeartbeatChecklistEditor
            missionId={id}
            checklist={heartbeatChecklist}
          />
          <ActiveHoursConfig
            missionId={id}
            activeHoursStart={activeHoursStart}
            activeHoursEnd={activeHoursEnd}
            activeHoursTimezone={activeHoursTimezone}
          />
        </div>
      )}

      {/* ── Schedule Wizard (missions without a schedule) ── */}
      {!scheduleCron && !['completed', 'archived'].includes(mission.status) && (
        <div className="mb-6">
          <ScheduleWizard
            missionId={id}
            hasWorkspace={!!mission.workspaceId}
            workspaces={teamWorkspaces}
          />
        </div>
      )}

      {/* ── Configuration ── */}
      {!['completed', 'archived'].includes(mission.status) && (
        <div className="mb-6">
          <MissionConfig
            missionId={id}
            workspaceId={mission.workspaceId}
            skillSlugs={skillSlugs}
            recipeId={recipeId}
            model={configModel}
            outputSchema={outputSchema}
            workspaces={teamWorkspaces}
          />
        </div>
      )}

      {/* ── Orchestration Timeline ── */}
      {displayCycles.length > 0 && (
        <div className="mb-6">
          <div className="flex items-center justify-between mb-3">
            <h2 className="section-label">Timeline</h2>
            {mission.status === 'completed' && totalTasks > 0 && (
              <Link
                href={`/app/tasks?mission=${id}`}
                className="text-[12px] text-accent-text hover:underline"
              >
                View all {totalTasks} tasks &rarr;
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
                      <span className={`w-3 h-3 rounded-full shrink-0 mt-0.5 ${evalIsRunning ? 'bg-status-info animate-status-pulse' : 'bg-[#D97706]'}`} />
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
                            <span className={`text-[12px] font-semibold ${evalIsRunning ? 'text-status-info' : 'text-[#92400E]'}`}>
                              {evalIsRunning ? 'Orchestrating...' : 'Orchestrated'}
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
                          triageOutcome === 'conflict'
                            ? <p className="text-[12px] text-text-secondary mt-1.5 leading-relaxed">{evalResult.summary}</p>
                            : <ExpandableText text={evalResult.summary} />
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
                              <button
                                type="button"
                                data-task-id={task.id}
                                className={`w-full flex items-center gap-2.5 px-2 py-1.5 rounded-md transition-colors group text-left ${
                                  isRunning
                                    ? 'bg-status-info/5 border border-status-info/20'
                                    : 'hover:bg-card-hover cursor-pointer'
                                }`}
                              >
                                {/* Branch line + role dot */}
                                <span className="flex items-center gap-1.5 shrink-0 w-5">
                                  <span className="w-2 h-px bg-border-default" />
                                  <span
                                    className="w-2 h-2 rounded-full shrink-0"
                                    style={{ backgroundColor: roleColor }}
                                  />
                                </span>

                                <span className={`flex-1 text-[13px] truncate transition-colors ${
                                  isDone ? 'text-text-secondary' : 'text-text-primary group-hover:text-accent-text'
                                }`}>
                                  {task.title}
                                </span>

                                {role && (
                                  <span
                                    className="text-[11px] font-medium shrink-0"
                                    style={{ color: roleColor }}
                                  >
                                    {role.name}
                                  </span>
                                )}

                                <span className="flex-1" />

                                {latestWorker?.prUrl && (
                                  <span className="text-[11px] text-accent-text shrink-0">
                                    PR #{latestWorker.prNumber}
                                  </span>
                                )}

                                {isRunning && (
                                  <span className="flex items-center gap-1 shrink-0 max-w-[45%]">
                                    <span className="w-1.5 h-1.5 rounded-full bg-status-info animate-status-pulse shrink-0" />
                                    <span className="text-[11px] text-status-info truncate">
                                      {latestWorker?.currentAction || 'Running'}
                                    </span>
                                  </span>
                                )}

                                {isDone && (
                                  <span className="text-[13px] text-status-success shrink-0">&#10003;</span>
                                )}

                                {isFailed && (
                                  <span className="text-[11px] text-status-error shrink-0">Failed</span>
                                )}

                                {!isRunning && !isDone && !isFailed && (
                                  <span className="text-[11px] text-text-muted shrink-0">
                                    {timeAgo(task.createdAt)}
                                  </span>
                                )}
                              </button>

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
                            </div>
                          );
                        })}
                      </div>
                    )}

                    {/* No tasks spawned */}
                    {cycle.evaluation && cycle.tasks.length === 0 && (
                      <p className="text-[12px] text-text-muted italic">No tasks needed</p>
                    )}
                  </div>
                </div>
              );
            })}

            {/* Next evaluation indicator — hidden for completed missions */}
            {scheduleCron && (mission.schedule as any)?.nextRunAt && mission.status !== 'completed' && (
              <div className="flex gap-0 items-center">
                <div className="flex flex-col items-center w-8 shrink-0">
                  <span className="w-3 h-3 rounded-full border-2 border-border-default bg-transparent shrink-0" />
                </div>
                <span className="text-[12px] text-text-muted italic pl-2">
                  Next evaluation {timeAgo((mission.schedule as any).nextRunAt)}
                </span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Heartbeat Timeline (heartbeat missions only) ── */}
      {isHeartbeat && heartbeatTasks.length > 0 && (
        <div className="mb-6">
          <HeartbeatTimeline
            tasks={heartbeatTasks.map(t => ({
              id: t.id,
              createdAt: t.createdAt,
              status: t.status,
              result: t.result,
            }))}
          />
        </div>
      )}

      {/* View all tasks link — hidden for completed missions (shown in timeline header instead) */}
      {totalTasks > 0 && mission.status !== 'completed' && (
        <div className="mb-6">
          <Link
            href={`/app/tasks?mission=${id}`}
            className="flex items-center gap-2 px-3 py-2.5 rounded-lg hover:bg-card-hover transition-colors group text-[13px] text-text-secondary hover:text-accent-text"
          >
            <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 6.75h12M8.25 12h12m-12 5.25h12M3.75 6.75h.007v.008H3.75V6.75zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zM3.75 12h.007v.008H3.75V12zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm-.375 5.25h.007v.008H3.75v-.008zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0z" />
            </svg>
            <span>View all {totalTasks} tasks</span>
            <svg className="w-3.5 h-3.5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
            </svg>
          </Link>
        </div>
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
