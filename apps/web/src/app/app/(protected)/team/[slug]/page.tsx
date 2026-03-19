import { db } from '@buildd/core/db';
import { workspaceSkills, workers, tasks, objectives, accountWorkspaces } from '@buildd/core/db/schema';
import { eq, and, or, inArray, desc, sql, count } from 'drizzle-orm';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth-helpers';
import { getUserWorkspaceIds } from '@/lib/team-access';
import { deriveMissionHealth, HEALTH_DISPLAY, timeAgo } from '@/lib/mission-helpers';

export const dynamic = 'force-dynamic';

const STATUS_DOT: Record<string, string> = {
  pending: 'bg-text-muted',
  queued: 'bg-status-info',
  running: 'bg-status-running animate-status-pulse',
  waiting_input: 'bg-status-warning animate-status-pulse',
  completed: 'bg-status-success',
  failed: 'bg-status-error',
};

function RoleAvatar({ name, color, size = 48 }: { name: string; color: string; size?: number }) {
  const initial = name[0]?.toUpperCase() || '?';
  return (
    <div
      className="rounded-full flex items-center justify-center flex-shrink-0"
      style={{ width: size, height: size, backgroundColor: color }}
    >
      <span className="text-white font-bold" style={{ fontSize: size * 0.4 }}>
        {initial}
      </span>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  if (status === 'waiting_input') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-status-warning/10 text-status-warning">
        <span className="w-1.5 h-1.5 rounded-full bg-status-warning" />
        Needs input
      </span>
    );
  }
  if (status === 'running' || status === 'starting') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-status-success/10 text-status-success">
        <span className="w-1.5 h-1.5 rounded-full bg-status-success animate-pulse" />
        Running
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-surface-3 text-text-muted">
      Idle
    </span>
  );
}

export default async function RoleProfilePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const user = await getCurrentUser();
  if (!user) redirect('/app/auth/signin');

  const wsIds = await getUserWorkspaceIds(user.id);
  if (wsIds.length === 0) notFound();

  // Get user's account IDs for account-level roles
  const userAccountWs = await db.query.accountWorkspaces.findMany({
    where: inArray(accountWorkspaces.workspaceId, wsIds),
    columns: { accountId: true },
  });
  const accountIds = [...new Set(userAccountWs.map(aw => aw.accountId))];

  // Find role by slug
  const role = await db.query.workspaceSkills.findFirst({
    where: and(
      eq(workspaceSkills.slug, slug),
      eq(workspaceSkills.isRole, true),
      or(
        inArray(workspaceSkills.workspaceId, wsIds),
        accountIds.length > 0 ? inArray(workspaceSkills.accountId, accountIds) : undefined,
      ),
    ),
  });

  if (!role) notFound();

  // Stats: completed, failed, success rate, avg duration, total cost
  const [statsResult] = await db
    .select({
      completedTasks: sql<number>`count(*) filter (where ${tasks.status} = 'completed')`.as('completed_tasks'),
      failedTasks: sql<number>`count(*) filter (where ${tasks.status} = 'failed')`.as('failed_tasks'),
      totalTasks: count(),
      totalCost: sql<string>`coalesce(sum(w.cost_usd::numeric), 0)`.as('total_cost'),
      avgDurationSec: sql<number>`coalesce(avg(extract(epoch from (w.completed_at - w.started_at)) / 60) filter (where w.completed_at is not null and w.started_at is not null), 0)`.as('avg_duration'),
    })
    .from(tasks)
    .leftJoin(sql`lateral (select cost_usd, completed_at, started_at from workers w2 where w2.task_id = ${tasks.id} order by w2.started_at desc limit 1) w`, sql`true`)
    .where(and(
      eq(tasks.roleSlug, slug),
      inArray(tasks.workspaceId, wsIds),
    ));

  const completedTasks = Number(statsResult?.completedTasks ?? 0);
  const failedTasks = Number(statsResult?.failedTasks ?? 0);
  const totalTaskCount = Number(statsResult?.totalTasks ?? 0);
  const successRate = totalTaskCount > 0 ? Math.round((completedTasks / totalTaskCount) * 100) : 0;
  const avgDurationMin = Math.round(Number(statsResult?.avgDurationSec ?? 0));
  const totalCost = Number(statsResult?.totalCost ?? 0);

  // Current active task
  const activeWorker = await db.query.workers.findFirst({
    where: and(
      inArray(workers.workspaceId, wsIds),
      inArray(workers.status, ['running', 'starting', 'waiting_input']),
    ),
    with: {
      task: {
        columns: { id: true, title: true, workspaceId: true, roleSlug: true },
        with: {
          workspace: { columns: { name: true } },
          objective: { columns: { title: true } },
        },
      },
    },
    orderBy: [desc(workers.startedAt)],
  });

  // Filter to matching role slug
  const currentWorker = activeWorker?.task && (activeWorker.task as any).roleSlug === slug ? activeWorker : null;

  // Assigned missions (objectives with defaultRoleSlug = slug)
  const assignedMissions = await db.query.objectives.findMany({
    where: and(
      eq(objectives.defaultRoleSlug, slug),
      inArray(objectives.status, ['active', 'paused', 'completed']),
    ),
    with: {
      tasks: {
        columns: { id: true, status: true },
      },
      schedule: {
        columns: { lastRunAt: true, nextRunAt: true } as any,
      },
    },
    orderBy: [desc(objectives.updatedAt)],
    limit: 20,
  });

  // Recent tasks
  const recentTasks = await db.query.tasks.findMany({
    where: and(
      eq(tasks.roleSlug, slug),
      inArray(tasks.workspaceId, wsIds),
    ),
    columns: {
      id: true,
      title: true,
      status: true,
      createdAt: true,
    },
    with: {
      workers: {
        columns: { id: true, prUrl: true, prNumber: true, costUsd: true, completedAt: true },
        orderBy: (w: any, { desc }: any) => [desc(w.startedAt)],
        limit: 1,
      },
    },
    orderBy: [desc(tasks.createdAt)],
    limit: 10,
  });

  // Resolve canDelegateTo slugs to names
  const delegateSlugs = (role.canDelegateTo as string[]) || [];
  let delegateRoles: { slug: string; name: string; color: string }[] = [];
  if (delegateSlugs.length > 0) {
    const allDelegates = await db.query.workspaceSkills.findMany({
      where: and(
        inArray(workspaceSkills.slug, delegateSlugs),
        eq(workspaceSkills.isRole, true),
        or(
          inArray(workspaceSkills.workspaceId, wsIds),
          accountIds.length > 0 ? inArray(workspaceSkills.accountId, accountIds) : undefined,
        ),
      ),
      columns: { slug: true, name: true, color: true },
    });
    // Dedupe by slug
    const seen = new Set<string>();
    delegateRoles = allDelegates.filter(d => {
      if (seen.has(d.slug)) return false;
      seen.add(d.slug);
      return true;
    });
  }

  // MCP servers / connectors
  const mcpServers = role.mcpServers as Record<string, unknown> | string[] | null;
  const connectorNames = mcpServers
    ? Array.isArray(mcpServers) ? mcpServers : Object.keys(mcpServers)
    : [];

  const modelLabel = role.model === 'inherit' ? 'Inherit' :
    role.model === 'opus' ? 'Claude Opus 4' :
    role.model === 'sonnet' ? 'Claude Sonnet 4' :
    role.model === 'haiku' ? 'Claude Haiku' :
    role.model || 'Inherit';

  // Determine overall status
  const overallStatus = currentWorker ? currentWorker.status : 'idle';

  return (
    <main className="min-h-screen pt-4 px-4 pb-20 md:pt-8 md:px-8 md:pb-8">
      <div className="max-w-5xl mx-auto">
        {/* Back link */}
        <Link href="/app/team" className="text-sm text-text-secondary hover:text-text-primary mb-4 block">
          &larr; The Team
        </Link>

        {/* Header */}
        <div className="flex items-center gap-4 mb-8">
          <RoleAvatar name={role.name} color={role.color} size={56} />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-bold text-text-primary">{role.name}</h1>
              <StatusBadge status={overallStatus} />
            </div>
            <div className="flex items-center gap-2 text-sm text-text-muted mt-0.5">
              <span className="font-mono text-xs">{role.slug}</span>
              <span>&middot;</span>
              <span>{modelLabel}</span>
            </div>
            {role.description && (
              <p className="text-sm text-text-secondary mt-1">{role.description}</p>
            )}
          </div>
          <Link
            href={`/app/workspaces/${role.workspaceId}/skills/${role.id}`}
            className="px-4 py-2 text-sm font-medium text-text-secondary hover:text-text-primary border border-border-default rounded-md hover:bg-surface-2 transition-colors shrink-0"
          >
            Edit Config
          </Link>
        </div>

        {/* Two-column layout */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Main column */}
          <div className="lg:col-span-2 space-y-6">
            {/* Current Task */}
            {currentWorker && currentWorker.task && (
              <section>
                <h2 className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-3">Current Task</h2>
                <Link
                  href={`/app/tasks/${(currentWorker.task as any).id}`}
                  className="block rounded-lg bg-[var(--card)] border border-border-default p-4 hover:bg-surface-2 transition-colors"
                >
                  <div className="text-[14px] font-medium text-text-primary mb-1">
                    {(currentWorker.task as any).title}
                  </div>
                  <div className="flex items-center gap-2 text-[12px] text-text-muted">
                    <span>{(currentWorker.task as any).workspace?.name}</span>
                    {currentWorker.startedAt && (
                      <>
                        <span>&middot;</span>
                        <span>{timeAgo(currentWorker.startedAt)}</span>
                      </>
                    )}
                    {(currentWorker as any).prUrl && (
                      <>
                        <span>&middot;</span>
                        <span className="text-accent-text">PR #{(currentWorker as any).prNumber}</span>
                      </>
                    )}
                    {(currentWorker.task as any).objective?.title && (
                      <>
                        <span>&middot;</span>
                        <span className="text-accent-text truncate max-w-[160px]">{(currentWorker.task as any).objective.title}</span>
                      </>
                    )}
                  </div>
                </Link>
              </section>
            )}

            {/* Assigned Missions */}
            <section>
              <h2 className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-3">Assigned Missions</h2>
              {assignedMissions.length === 0 ? (
                <p className="text-sm text-text-muted">No missions assigned to this role.</p>
              ) : (
                <div className="space-y-2">
                  {assignedMissions.map(mission => {
                    const mTotalTasks = mission.tasks?.length || 0;
                    const mCompletedTasks = mission.tasks?.filter(t => t.status === 'completed').length || 0;
                    const mActiveAgents = mission.tasks
                      ?.filter(t => t.status === 'running').length || 0;
                    const health = deriveMissionHealth({
                      status: mission.status,
                      activeAgents: mActiveAgents,
                      cronExpression: mission.cronExpression,
                      lastRunAt: (mission.schedule as any)?.lastRunAt || null,
                      nextRunAt: (mission.schedule as any)?.nextRunAt || null,
                      completedTasks: mCompletedTasks,
                      totalTasks: mTotalTasks,
                    });
                    const display = HEALTH_DISPLAY[health];

                    return (
                      <Link
                        key={mission.id}
                        href={`/app/missions/${mission.id}`}
                        className="flex items-center justify-between rounded-lg bg-[var(--card)] border border-border-default px-4 py-3 hover:bg-surface-2 transition-colors"
                      >
                        <span className="text-[13px] font-medium text-text-primary truncate">{mission.title}</span>
                        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium ${display.colorClass}`}>
                          {display.label}
                        </span>
                      </Link>
                    );
                  })}
                </div>
              )}
            </section>

            {/* Recent Tasks */}
            <section>
              <h2 className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-3">Recent Tasks</h2>
              {recentTasks.length === 0 ? (
                <p className="text-sm text-text-muted">No tasks yet.</p>
              ) : (
                <div className="space-y-1">
                  {recentTasks.map(task => {
                    const latestWorker = task.workers?.[0];
                    const dotClass = STATUS_DOT[task.status] || STATUS_DOT.pending;
                    return (
                      <Link
                        key={task.id}
                        href={`/app/tasks/${task.id}`}
                        className="flex items-center gap-3 rounded-md px-3 py-2 hover:bg-surface-2 transition-colors group"
                      >
                        <span className={`w-2 h-2 rounded-full flex-shrink-0 ${dotClass}`} />
                        <span className="text-[13px] text-text-primary truncate flex-1 group-hover:text-accent-text">
                          {task.title}
                        </span>
                        <span className="text-[11px] text-text-muted shrink-0">{task.status}</span>
                        {latestWorker?.prNumber && (
                          <span className="text-[11px] text-accent-text shrink-0">PR #{latestWorker.prNumber}</span>
                        )}
                        <span className="text-[11px] text-text-muted shrink-0">{timeAgo(task.createdAt)}</span>
                      </Link>
                    );
                  })}
                </div>
              )}
            </section>
          </div>

          {/* Sidebar */}
          <div className="space-y-6">
            {/* Stats */}
            <section className="rounded-lg bg-[var(--card)] border border-border-default p-4">
              <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-3">Stats</h3>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <div className="text-xl font-bold text-text-primary">{completedTasks}</div>
                  <div className="text-[11px] text-text-muted">Completed</div>
                </div>
                <div>
                  <div className="text-xl font-bold text-text-primary">{successRate}%</div>
                  <div className="text-[11px] text-text-muted">Success rate</div>
                </div>
                <div>
                  <div className="text-xl font-bold text-text-primary">{avgDurationMin}m</div>
                  <div className="text-[11px] text-text-muted">Avg duration</div>
                </div>
                <div>
                  <div className="text-xl font-bold text-text-primary">{failedTasks}</div>
                  <div className="text-[11px] text-text-muted">Failed</div>
                </div>
              </div>
              {totalCost > 0 && (
                <div className="mt-3 pt-3 border-t border-border-default">
                  <div className="text-sm font-medium text-text-primary">${totalCost.toFixed(2)}</div>
                  <div className="text-[11px] text-text-muted">Total cost</div>
                </div>
              )}
            </section>

            {/* Capabilities */}
            <section className="rounded-lg bg-[var(--card)] border border-border-default p-4">
              <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-3">Capabilities</h3>

              {delegateRoles.length > 0 && (
                <div className="mb-3">
                  <div className="text-[11px] text-text-muted mb-1.5">Can delegate to</div>
                  <div className="flex flex-wrap gap-1.5">
                    {delegateRoles.map(d => (
                      <Link
                        key={d.slug}
                        href={`/app/team/${d.slug}`}
                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-surface-2 text-text-secondary hover:text-text-primary transition-colors"
                      >
                        <span className="w-2 h-2 rounded-full" style={{ backgroundColor: d.color }} />
                        {d.name}
                      </Link>
                    ))}
                  </div>
                </div>
              )}

              {connectorNames.length > 0 && (
                <div>
                  <div className="text-[11px] text-text-muted mb-1.5">Connectors</div>
                  <div className="flex flex-wrap gap-1.5">
                    {connectorNames.map(name => (
                      <span
                        key={name}
                        className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-mono bg-surface-2 text-text-muted"
                      >
                        {name}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {delegateRoles.length === 0 && connectorNames.length === 0 && (
                <p className="text-[12px] text-text-muted">No delegation or connectors configured.</p>
              )}
            </section>
          </div>
        </div>
      </div>
    </main>
  );
}
