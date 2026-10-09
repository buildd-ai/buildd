import { db } from '@buildd/core/db';
import { workspaceSkills, workers, tasks, missions, accountWorkspaces, workspaces } from '@buildd/core/db/schema';
import { eq, and, or, isNull, inArray, desc, sql, count } from 'drizzle-orm';
import Link from 'next/link';
import SettingsPage from '../../_components/SettingsPage';
import Section from '@/components/ui/Section';
import PrimaryAction from '@/components/ui/PrimaryAction';
import StatePill, { TonePill } from '@/components/ui/StatePill';
import type { StateTone } from '@/components/ui/states';
import { notFound, redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth-helpers';
import { getUserWorkspaceIds } from '@/lib/team-access';
import { deriveMissionHealth, HEALTH_DISPLAY, timeAgo, type MissionHealth } from '@/lib/mission-helpers';
import { hasPendingDeliverableWork } from '@buildd/core/mission-helpers';
import { LIVE_WORKER_STATUSES } from '@/lib/task-presentation';
import { RecentTaskRow, CurrentTaskCard } from './RoleTaskRows';
import { roleModelLabel } from '@/lib/model-presentation';
import { formatEstimatedUsd, ESTIMATED_COST_TITLE } from '@/lib/cost-label';

export const dynamic = 'force-dynamic';

/** Mission health as a tone: orange only for a live mission, amber for one that needs a decision. */
const HEALTH_TONE: Record<MissionHealth, StateTone> = {
  active: 'act',
  'on-schedule': 'run',
  stalled: 'bad',
  shipped: 'ok',
  paused: 'q',
  held: 'q',
  idle: 'q',
  'budget-exhausted': 'bad',
  escalated: 'dec',
};

function RoleStatePill({ status }: { status: string }) {
  if (status === 'waiting_input') return <StatePill state="waiting" label="Needs input" />;
  if (status === 'running' || status === 'starting') return <StatePill state="running" label="Running" />;
  return <TonePill tone="q">Idle</TonePill>;
}

/** One figure in the stats block: the number in mono, its label below. */
function Stat({ value, label, title }: { value: string; label: string; title?: string }) {
  return (
    <div title={title}>
      <div className="font-mono text-lg font-semibold text-text-primary">{value}</div>
      <div className="text-sm text-text-muted">{label}</div>
    </div>
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

  // Get user's team IDs for team-level role lookup
  const { getUserTeamIds } = await import('@/lib/team-access');
  const teamIds = await getUserTeamIds(user.id);

  // Find role by slug — prefer workspace-override, fall back to team default.
  // Team roles only: a personal row is team-level too, and another member's
  // private one must never resolve here (personal roles open by id instead).
  const role = await db.query.workspaceSkills.findFirst({
    where: and(
      eq(workspaceSkills.slug, slug),
      eq(workspaceSkills.isRole, true),
      or(
        wsIds.length > 0 ? inArray(workspaceSkills.workspaceId, wsIds) : undefined,
        teamIds.length > 0 ? and(isNull(workspaceSkills.workspaceId), isNull(workspaceSkills.ownerUserId), inArray(workspaceSkills.teamId, teamIds)) : undefined,
        accountIds.length > 0 ? inArray(workspaceSkills.accountId, accountIds) : undefined,
      ),
    ),
    orderBy: [sql`(${workspaceSkills.workspaceId} IS NOT NULL) DESC`],
  });

  if (!role) notFound();

  // Resolve workspace name for scope display
  const scopeWorkspaceName = role.workspaceId
    ? (await db.query.workspaces.findFirst({
        where: eq(workspaces.id, role.workspaceId),
        columns: { name: true },
      }))?.name ?? null
    : null;

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
      isNull(tasks.parentTaskId),
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
      inArray(workers.status, [...LIVE_WORKER_STATUSES]),
    ),
    with: {
      task: {
        columns: { id: true, title: true, workspaceId: true, roleSlug: true },
        with: {
          workspace: { columns: { name: true } },
          mission: { columns: { title: true } },
        },
      },
    },
    orderBy: [desc(workers.startedAt)],
  });

  // Filter to matching role slug
  const currentWorker = activeWorker?.task && (activeWorker.task as any).roleSlug === slug ? activeWorker : null;

  // Find missions that have tasks routed to this role (via tasks.roleSlug)
  const missionIdsWithRole = await db
    .selectDistinct({ missionId: tasks.missionId })
    .from(tasks)
    .where(and(
      eq(tasks.roleSlug, slug),
      inArray(tasks.workspaceId, wsIds),
      sql`${tasks.missionId} IS NOT NULL`,
    ))
    .limit(20);

  const missionIds = missionIdsWithRole
    .map(r => r.missionId)
    .filter(Boolean) as string[];

  const assignedMissions = missionIds.length > 0
    ? await db.query.missions.findMany({
        where: and(
          inArray(missions.id, missionIds),
          inArray(missions.status, ['active', 'paused', 'completed']),
        ),
        with: {
          tasks: {
            // taskClass & co. feed isDeliverableTask (hasPendingDeliverableWork);
            // without them every attempt and bookkeeping row reads as open work.
            columns: { id: true, status: true, taskClass: true, kind: true, title: true, mode: true, category: true },
            // Live agents are workers, not a task status — tasks have no 'running'.
            // Only live rows are loaded; worker history is not needed here.
            with: { workers: { columns: { status: true }, where: inArray(workers.status, [...LIVE_WORKER_STATUSES]) } },
          },
          schedule: {
            columns: { lastRunAt: true, nextRunAt: true, cronExpression: true } as any,
          },
        },
        orderBy: [desc(missions.updatedAt)],
        limit: 20,
      })
    : [];

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

  const modelLabel = roleModelLabel(role.model);

  // Determine overall status
  const overallStatus = currentWorker ? currentWorker.status : 'idle';

  // A workspace-scoped role shares its slug with others elsewhere, so its editor link carries the id.
  const editHref = role.workspaceId
    ? `/app/settings/roles/${encodeURIComponent(role.slug)}/edit?id=${encodeURIComponent(role.id)}`
    : `/app/settings/roles/${encodeURIComponent(role.slug)}/edit`;
  const ROWS = 'divide-y divide-border-default border-y border-border-default';

  return (
    <SettingsPage
      title={role.name}
      description={
        <span className="flex flex-col gap-1">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <RoleStatePill status={overallStatus} />
            <span className="font-mono text-meta">{role.slug}</span>
            <span>· <span className="font-mono text-meta">{modelLabel}</span></span>
            <span>· {scopeWorkspaceName ?? 'All workspaces'}</span>
          </span>
          {role.description && <span>{role.description}</span>}
        </span>
      }
    >
      <div>
        <PrimaryAction href={editHref}>Edit role</PrimaryAction>
      </div>

      {currentWorker && currentWorker.task && (
        <Section title="Current task">
          <CurrentTaskCard
            task={{
              id: (currentWorker.task as any).id,
              title: (currentWorker.task as any).title,
              workspaceName: (currentWorker.task as any).workspace?.name,
              missionTitle: (currentWorker.task as any).mission?.title,
            }}
            startedAgo={currentWorker.startedAt ? timeAgo(currentWorker.startedAt) : null}
            prNumber={(currentWorker as any).prNumber}
            prUrl={(currentWorker as any).prUrl}
          />
        </Section>
      )}

      <Section title="Stats">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Stat value={String(completedTasks)} label="Completed" />
          <Stat value={`${successRate}%`} label="Success rate" />
          <Stat value={`${avgDurationMin}m`} label="Avg duration" />
          <Stat value={String(failedTasks)} label="Failed" />
          {totalCost > 0 && <Stat value={formatEstimatedUsd(totalCost)} label="Total cost" title={ESTIMATED_COST_TITLE} />}
        </div>
      </Section>

      <Section title="Assigned missions" count={assignedMissions.length || undefined}>
        {assignedMissions.length === 0 ? (
          <p className="text-sm text-text-muted">No missions assigned to this role.</p>
        ) : (
          <div className={ROWS}>
            {assignedMissions.map(mission => {
              const mActiveAgents = (mission.tasks ?? [])
                .flatMap(t => t.workers ?? [])
                .filter(w => (LIVE_WORKER_STATUSES as readonly string[]).includes(w.status)).length;
              const health = deriveMissionHealth({
                status: mission.status,
                activeAgents: mActiveAgents,
                cronExpression: (mission.schedule as any)?.cronExpression || null,
                lastRunAt: (mission.schedule as any)?.lastRunAt || null,
                nextRunAt: (mission.schedule as any)?.nextRunAt || null,
                orchestrationMode: mission.orchestrationMode ?? null,
                isHeld: mission.isHeld ?? false,
                executor: (mission as { executor?: string | null }).executor ?? null,
                criteriaEscalatedAt: mission.criteriaEscalatedAt,
                hasPendingDeliverableWork: hasPendingDeliverableWork(mission.tasks ?? []),
              });

              return (
                <Link
                  key={mission.id}
                  href={`/app/missions/${mission.id}`}
                  className="flex min-h-11 items-center justify-between gap-3 py-2 hover:bg-surface-3 transition-colors"
                >
                  <span className="truncate text-sm font-medium text-text-primary">{mission.title}</span>
                  <TonePill tone={HEALTH_TONE[health]}>{HEALTH_DISPLAY[health].label}</TonePill>
                </Link>
              );
            })}
          </div>
        )}
      </Section>

      <Section title="Recent tasks">
        {recentTasks.length === 0 ? (
          <p className="text-sm text-text-muted">No tasks.</p>
        ) : (
          <div className={ROWS}>
            {recentTasks.map(task => {
              const latestWorker = task.workers?.[0];
              return (
                <RecentTaskRow
                  key={task.id}
                  task={task}
                  createdAgo={timeAgo(task.createdAt)}
                  prNumber={latestWorker?.prNumber}
                  prUrl={latestWorker?.prUrl}
                />
              );
            })}
          </div>
        )}
      </Section>

      <Section title="Capabilities">
        {delegateRoles.length === 0 && connectorNames.length === 0 ? (
          <p className="text-sm text-text-muted">No delegation or connectors configured.</p>
        ) : (
          <div className={ROWS}>
            {delegateRoles.length > 0 && (
              <div className="py-2.5">
                <div className="mb-1.5 text-sm text-text-muted">Can delegate to</div>
                <div className="flex flex-wrap gap-1.5">
                  {delegateRoles.map(d => (
                    <Link key={d.slug} href={`/app/settings/roles/${d.slug}`} className="btn btn-sm h-11 md:h-6">
                      {d.name}
                    </Link>
                  ))}
                </div>
              </div>
            )}
            {connectorNames.length > 0 && (
              <div className="py-2.5">
                <div className="mb-1.5 text-sm text-text-muted">Connectors</div>
                <p className="font-mono text-meta text-text-secondary">{connectorNames.join(', ')}</p>
              </div>
            )}
          </div>
        )}
      </Section>
    </SettingsPage>
  );
}
