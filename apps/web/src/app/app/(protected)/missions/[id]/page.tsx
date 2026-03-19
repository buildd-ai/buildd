import { db } from '@buildd/core/db';
import { objectives, workspaceSkills } from '@buildd/core/db/schema';
import { eq, and, inArray, desc } from 'drizzle-orm';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth-helpers';
import { getUserTeamIds, getUserWorkspaceIds } from '@/lib/team-access';
import { deriveMissionHealth, HEALTH_DISPLAY, timeAgo } from '@/lib/mission-helpers';
import WorkerRespondInput from '@/components/WorkerRespondInput';
import MissionSettings from './MissionSettings';
import MissionInlineEdit from './MissionInlineEdit';

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

  const objective = await db.query.objectives.findFirst({
    where: eq(objectives.id, id),
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

  if (!objective || !teamIds.includes(objective.teamId)) {
    notFound();
  }

  // Query roles for this user's workspaces
  const wsIds = await getUserWorkspaceIds(user.id);
  let roles: { slug: string; name: string; color: string }[] = [];
  if (wsIds.length > 0) {
    roles = await db.query.workspaceSkills.findMany({
      where: and(
        inArray(workspaceSkills.workspaceId, wsIds),
        eq(workspaceSkills.enabled, true),
      ),
      columns: { slug: true, name: true, color: true },
      orderBy: [desc(workspaceSkills.createdAt)],
    });
  }

  const totalTasks = objective.tasks?.length || 0;
  const completedTasks = objective.tasks?.filter((t) => t.status === 'completed').length || 0;
  const progress = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;

  const activeAgents = objective.tasks
    ?.flatMap((t) => t.workers || [])
    .filter((w) => w.status === 'running').length || 0;

  const health = deriveMissionHealth({
    status: objective.status,
    activeAgents,
    cronExpression: objective.cronExpression,
    lastRunAt: (objective.schedule as any)?.lastRunAt || null,
    nextRunAt: (objective.schedule as any)?.nextRunAt || null,
  });
  const healthDisplay = HEALTH_DISPLAY[health];

  // Build roles map for color lookup
  const rolesMap = new Map<string, { name: string; color: string }>();
  roles.forEach((r) => rolesMap.set(r.slug, { name: r.name, color: r.color }));

  // Build orchestration timeline: group tasks into cycles
  // Planning tasks = evaluation nodes, execution tasks = branches
  const allTasks = (objective.tasks || []).slice().sort(
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

  // Collect all artifacts
  const allArtifacts = objective.tasks?.flatMap((t) =>
    t.workers?.flatMap((w) =>
      (w.artifacts || []).map((a) => ({ ...a, taskTitle: t.title, workerStatus: w.status }))
    ) || []
  ) || [];

  return (
    <div className="px-7 md:px-10 pt-5 md:pt-8 pb-12 max-w-3xl">
      {/* Breadcrumbs */}
      <div className="flex items-center gap-2 text-[12px] text-text-muted mb-5">
        <Link href="/app/missions" className="hover:text-text-secondary transition-colors">
          Missions
        </Link>
        <span>/</span>
        <span className="text-text-secondary truncate">{objective.title}</span>
      </div>

      {/* ── Status Block ── */}
      <div className="mb-6">
        <MissionInlineEdit
          missionId={id}
          initialTitle={objective.title}
          initialDescription={objective.description}
          healthPill={
            <span className={`health-pill ${healthDisplay.colorClass}`}>
              {healthDisplay.label}
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
              {completedTasks} of {totalTasks} tasks complete
            </div>
          </div>
        )}

        {/* Workspace link */}
        {objective.workspace && (
          <div className="flex items-center gap-2 text-[12px] text-text-muted">
            <Link
              href={`/app/workspaces/${objective.workspace.id}`}
              className="text-accent-text hover:underline"
            >
              {objective.workspace.name}
            </Link>
          </div>
        )}
      </div>

      {/* Mission Controls & Quick Task */}
      <div className="mb-6">
        <MissionSettings
          missionId={id}
          currentStatus={objective.status}
          cronExpression={objective.cronExpression}
          defaultRoleSlug={objective.defaultRoleSlug}
          workspaceId={objective.workspaceId}
          roles={roles}
          schedule={objective.schedule ? {
            nextRunAt: (objective.schedule as any).nextRunAt?.toISOString?.() || (objective.schedule as any).nextRunAt || null,
            lastRunAt: (objective.schedule as any).lastRunAt?.toISOString?.() || (objective.schedule as any).lastRunAt || null,
          } : null}
          hasSchedule={!!objective.cronExpression}
        />
      </div>

      {/* ── Orchestration Timeline ── */}
      {cycles.length > 0 && (
        <div className="mb-6">
          <h2 className="section-label mb-3">Timeline</h2>
          <div className="relative">
            {cycles.map((cycle, ci) => {
              const isLast = ci === cycles.length - 1;
              const evalResult = cycle.evaluation?.result as { summary?: string } | null;

              return (
                <div key={cycle.evaluation?.id || `cycle-${ci}`} className="flex gap-0">
                  {/* Spine */}
                  <div className="flex flex-col items-center w-8 shrink-0">
                    {cycle.evaluation ? (
                      <span className="w-3 h-3 rounded-full bg-[#D97706] shrink-0 mt-0.5" />
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
                          <span className="text-[12px] font-semibold text-[#92400E]">Evaluate</span>
                          <span className="text-[11px] text-text-muted">{timeAgo(cycle.evaluation.createdAt)}</span>
                        </div>
                        {evalResult?.summary && (
                          <p className="text-[12px] text-text-secondary italic leading-relaxed mt-1 line-clamp-2">
                            {evalResult.summary}
                          </p>
                        )}
                      </div>
                    )}

                    {/* Task branches */}
                    {cycle.tasks.length > 0 && (
                      <div className="space-y-0.5">
                        {cycle.tasks.map((task) => {
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
                            <div key={task.id}>
                              <Link
                                href={`/app/tasks/${task.id}`}
                                className={`flex items-center gap-2.5 px-2 py-1.5 rounded-md transition-colors group ${
                                  isRunning
                                    ? 'bg-status-info/5 border border-status-info/20'
                                    : 'hover:bg-card-hover'
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
                                  <span className="flex items-center gap-1 shrink-0">
                                    <span className="w-1.5 h-1.5 rounded-full bg-status-info animate-status-pulse" />
                                    <span className="text-[11px] text-status-info font-medium">Running</span>
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
                              </Link>

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

            {/* Next evaluation indicator */}
            {objective.cronExpression && (objective.schedule as any)?.nextRunAt && (
              <div className="flex gap-0 items-center">
                <div className="flex flex-col items-center w-8 shrink-0">
                  <span className="w-3 h-3 rounded-full border-2 border-border-default bg-transparent shrink-0" />
                </div>
                <span className="text-[12px] text-text-muted italic pl-2">
                  Next evaluation {timeAgo((objective.schedule as any).nextRunAt)}
                </span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* View all tasks link */}
      {totalTasks > 0 && (
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
  );
}
