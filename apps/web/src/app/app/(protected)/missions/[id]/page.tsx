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

  const activeTasks = objective.tasks?.filter(
    (t) => !['completed', 'failed'].includes(t.status)
  ) || [];
  const doneTasks = objective.tasks?.filter(
    (t) => ['completed', 'failed'].includes(t.status)
  ) || [];

  // Collect all artifacts
  const allArtifacts = objective.tasks?.flatMap((t) =>
    t.workers?.flatMap((w) =>
      (w.artifacts || []).map((a) => ({ ...a, taskTitle: t.title, workerStatus: w.status }))
    ) || []
  ) || [];

  // Collect recent worker activity
  const recentActivity = objective.tasks
    ?.flatMap((t) =>
      (t.workers || []).map((w) => ({
        taskId: t.id,
        taskTitle: t.title,
        workerId: w.id,
        status: w.status,
        currentAction: w.currentAction,
        prUrl: w.prUrl,
        prNumber: w.prNumber,
        branch: w.branch,
        turns: w.turns,
        costUsd: w.costUsd,
        commitCount: w.commitCount,
        filesChanged: w.filesChanged,
        startedAt: w.startedAt,
        completedAt: w.completedAt,
      }))
    )
    .sort((a, b) => {
      const aTime = a.completedAt || a.startedAt;
      const bTime = b.completedAt || b.startedAt;
      if (!bTime) return -1;
      if (!aTime) return 1;
      return new Date(bTime).getTime() - new Date(aTime).getTime();
    })
    .slice(0, 8) || [];

  // Last evaluation — most recent planning-mode completed task
  const lastEvaluation = objective.tasks?.find(
    (t) => t.mode === 'planning' && t.status === 'completed' && t.result
  );

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
        <div className="flex flex-wrap items-center gap-3 mb-2">
          <h1 className="text-xl font-semibold text-text-primary font-sans">
            {objective.title}
          </h1>
          <span className={`health-pill ${healthDisplay.colorClass}`}>
            {healthDisplay.label}
          </span>
        </div>

        {objective.description && (
          <p className="text-[13px] text-text-desc leading-relaxed mb-4">
            {objective.description}
          </p>
        )}

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

      {/* ── Orchestrator / Last Evaluation ── */}
      {lastEvaluation && (
        <div className="mb-6">
          <h2 className="section-label mb-3">Last Evaluation</h2>
          <div className="card p-4">
            <p className="text-[13px] text-text-secondary leading-relaxed line-clamp-4">
              {(lastEvaluation.result as any)?.summary || 'Evaluation completed'}
            </p>
            <div className="text-[11px] text-text-muted mt-2">
              {timeAgo(lastEvaluation.createdAt)}
            </div>
          </div>
        </div>
      )}

      {/* ── Task Tree ── */}
      {activeTasks.length > 0 && (
        <div className="mb-6">
          <h2 className="section-label mb-3">Active Tasks ({activeTasks.length})</h2>
          <div className="space-y-1.5">
            {activeTasks.map((task) => {
              const latestWorker = task.workers?.[0];
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
                    className="flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-card-hover transition-colors group"
                  >
                    <span
                      className={`w-2 h-2 rounded-full shrink-0 ${STATUS_DOT[task.status] || 'bg-text-muted'}`}
                    />
                    <span className="flex-1 text-[13px] text-text-primary truncate group-hover:text-accent-text transition-colors">
                      {task.title}
                    </span>
                    {latestWorker?.currentAction && !waitingWorker && (
                      <span className="hidden md:block text-[11px] text-text-muted truncate max-w-[200px]">
                        {latestWorker.currentAction}
                      </span>
                    )}
                    <span className="text-[11px] text-text-muted shrink-0">
                      {timeAgo(task.createdAt)}
                    </span>
                  </Link>
                  {waitingWorker && waitingFor && (
                    <div className="px-3 pb-2">
                      <span className="section-label text-status-warning">Needs your input</span>
                      <WorkerRespondInput
                        workerId={waitingWorker.id}
                        question={waitingFor.prompt}
                        options={waitingFor.options}
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {doneTasks.length > 0 && (
        <div className="mb-6">
          <h2 className="section-label mb-3">Completed ({doneTasks.length})</h2>
          <div className="space-y-1.5">
            {doneTasks.slice(0, 5).map((task) => {
              const latestWorker = task.workers?.[0];
              return (
                <Link
                  key={task.id}
                  href={`/app/tasks/${task.id}`}
                  className="flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-card-hover transition-colors opacity-70 group"
                >
                  <span
                    className={`w-2 h-2 rounded-full shrink-0 ${STATUS_DOT[task.status] || 'bg-text-muted'}`}
                  />
                  <span className="flex-1 text-[13px] text-text-primary truncate">
                    {task.title}
                  </span>
                  {latestWorker?.prUrl && (
                    <span className="text-[11px] text-accent-text shrink-0">
                      PR #{latestWorker.prNumber}
                    </span>
                  )}
                  <span className="text-[11px] text-text-muted shrink-0">
                    {timeAgo(task.createdAt)}
                  </span>
                </Link>
              );
            })}
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

      {/* ── Activity Feed ── */}
      {recentActivity.length > 0 && (
        <div className="mb-6">
          <h2 className="section-label mb-3">Recent Activity</h2>
          <div className="space-y-2">
            {recentActivity.map((w) => (
              <div
                key={w.workerId}
                className="flex items-center gap-3 px-3 py-2.5 rounded-lg bg-card border border-card-border"
              >
                <span
                  className={`w-2 h-2 rounded-full shrink-0 ${STATUS_DOT[w.status] || 'bg-text-muted'}`}
                />
                <div className="flex-1 min-w-0">
                  <Link
                    href={`/app/tasks/${w.taskId}`}
                    className="text-[13px] text-text-primary hover:text-accent-text truncate block transition-colors"
                  >
                    {w.taskTitle}
                  </Link>
                  {w.currentAction && (
                    <p className="text-[11px] text-text-muted truncate mt-0.5">
                      {w.currentAction}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-2.5 text-[11px] text-text-muted shrink-0">
                  {w.commitCount ? (
                    <span>{w.commitCount} commit{w.commitCount !== 1 ? 's' : ''}</span>
                  ) : null}
                  {w.prUrl && (
                    <a
                      href={w.prUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-accent-text hover:underline"
                    >
                      PR #{w.prNumber}
                    </a>
                  )}
                  {(w.completedAt || w.startedAt) && (
                    <span>{timeAgo(w.completedAt || w.startedAt!)}</span>
                  )}
                </div>
              </div>
            ))}
          </div>
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
