import { db } from '@buildd/core/db';
import { workspaces, tasks, taskSchedules, workers, artifacts, missions, memories, accountWorkspaces, accounts } from '@buildd/core/db/schema';
import { eq, desc, and, count, notInArray, sql } from 'drizzle-orm';
import { workspaceProjectKey } from '@buildd/core/project-scope';
import Link from 'next/link';
import { NewWorkLink } from '@/components/chat/ChatEntry';
import { notFound, redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth-helpers';
import { verifyWorkspaceAccess } from '@/lib/team-access';
import { roleHas } from '@/lib/permission-registry';
import { RepoLinkCard } from '../../settings/workspace/[workspaceId]/RepoLinkCard';

import { primaryActionClass } from '@/components/ui/PrimaryAction';
import Lede from '@/components/ui/Lede';
import Section from '@/components/ui/Section';
import { StatusPill } from '@/components/ui/StatePill';
import { taskCountLede } from './overview-lede';
import { displayTaskTitle } from '@/lib/task-title';
import { readRound } from '@/lib/read-round';

export default async function WorkspaceDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const isDev = process.env.NODE_ENV === 'development' && (!process.env.DATABASE_URL || !process.env.DEV_USER_EMAIL); // placeholder unless dev has a DB + dev user
  const user = await getCurrentUser();

  if (isDev) {
    return (
      <main className="pt-[4.5rem] px-4 pb-24 md:px-8 md:pt-8 md:pb-10">
        <p className="text-text-muted">Development mode · no database</p>
      </main>
    );
  }

  if (!user) {
    redirect('/app/auth/signin');
  }

  const access = await verifyWorkspaceAccess(user.id, id);
  if (!access) notFound();

  // One round trip for every read that needs only the workspace id
  // (readRound): the row's four shown columns, whether any account may claim
  // here (one link row, never the accounts' credentials), the five newest tasks'
  // title and status, and the counts. The memory count needs the row's
  // repo and name, so it is the second round.
  const round = await readRound({
    ws: db.select({ id: workspaces.id, name: workspaces.name, repo: workspaces.repo, teamId: workspaces.teamId })
      .from(workspaces).where(eq(workspaces.id, id)).limit(1),
    hasRunner: db.select({ accountId: accountWorkspaces.accountId }).from(accountWorkspaces)
      .innerJoin(accounts, eq(accounts.id, accountWorkspaces.accountId))
      .where(and(eq(accountWorkspaces.workspaceId, id), eq(accountWorkspaces.canClaim, true))).limit(1),
    recent: db.select({ id: tasks.id, title: tasks.title, status: tasks.status }).from(tasks)
      .where(eq(tasks.workspaceId, id)).orderBy(desc(tasks.createdAt)).limit(5),
    taskCounts: db.select({ status: tasks.status, count: count() }).from(tasks).where(eq(tasks.workspaceId, id)).groupBy(tasks.status),
    schedCount: db.select({ count: count() }).from(taskSchedules).where(eq(taskSchedules.workspaceId, id)),
    missionCount: db.select({ count: count() }).from(missions).where(eq(missions.workspaceId, id)),
    // Deliverable artifacts (plan types excluded) of the workspace's workers.
    artCount: db.select({ count: count() }).from(artifacts).where(and(
      sql`${artifacts.workerId} in (select ${workers.id} from ${workers} where ${workers.workspaceId} = ${id}::uuid)`,
      notInArray(artifacts.type, ['impl_plan']),
    )),
  });
  const [row] = round.ws;
  if (!row) {
    notFound();
  }
  const workspace = { ...row, tasks: round.recent };

  // Any account that may claim here counts as a runner; the setup lives in Settings › Runners.
  const hasRunner = round.hasRunner.length > 0;

  const taskCountMap = Object.fromEntries(round.taskCounts.map((t) => [t.status, Number(t.count)]));

  // Scoped by project the same way /api/workspaces/:id/memory scopes its list, so the
  // badge matches what the Memory tab actually shows. Without the project filter every
  // workspace in a team reports the team's whole memory pool.
  //
  // This was a substring ILIKE against the raw repo/name, which silently undercounted:
  // when `repo` is a full URL and the rows store the short `owner/repo` form, the
  // `%<full url>%` pattern matches nothing, so the badge read far lower than the
  // number of memories actually scoped to the workspace. Both sides now reduce to the
  // canonical `owner/repo` key (see project-scope.ts) and compare exactly, which also
  // lets the (team_id, project) index serve the count.
  const memoryProject = workspaceProjectKey(workspace.repo, workspace.name);
  const [memCountRes] = await db
    .select({ total: count() })
    .from(memories)
    .where(and(
      eq(memories.teamId, workspace.teamId),
      ...(memoryProject ? [eq(memories.project, memoryProject)] : []),
    ));
  const memoryCount = Number(memCountRes?.total || 0);
  const scheduleCount = Number(round.schedCount[0]?.count || 0);
  const missionCount = Number(round.missionCount[0]?.count || 0);
  const artifactCount = Number(round.artCount[0]?.count || 0);

  const canManage = roleHas(access.role, 'manage_workspace_settings');
  const links: Array<{ href: string; label: string; count?: number }> = [
    { href: `/app/settings/workspace/${workspace.id}`, label: 'Settings' },
    { href: `/app/workspaces/${workspace.id}/memory`, label: 'Memory', count: memoryCount },
    { href: `/app/missions?workspaceId=${workspace.id}`, label: 'Missions', count: missionCount },
    { href: `/app/workspaces/${workspace.id}/schedules`, label: 'Schedules', count: scheduleCount },
    { href: `/app/workspaces/${workspace.id}/artifacts`, label: 'Artifacts', count: artifactCount },
    { href: `/app/workspaces/${workspace.id}/specs`, label: 'Specs' },
    { href: `/app/health/runners?workspace=${workspace.id}`, label: 'Runners' },
    { href: '/app/settings/agents', label: 'Agents' },
  ];

  return (
    <main className="pt-[4.5rem] px-4 pb-24 md:px-8 md:pt-8 md:pb-10">
      <div className="max-w-4xl space-y-6">
        <header className="flex flex-col md:flex-row md:items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-xl font-semibold text-text-primary break-all">{workspace.name}</h1>
            {workspace.repo && (
              <p className="mt-1 font-mono text-sm text-text-muted break-all">{workspace.repo}</p>
            )}
          </div>
          {/* Delete lives in Settings' danger zone, not beside the primary action. */}
          <NewWorkLink
            kind="task"
            workspaceId={workspace.id}
            className={primaryActionClass({ fullWidthOnMobile: true, className: 'shrink-0' })}
          >
            New task
          </NewWorkLink>
        </header>

        <nav aria-label="Workspace" data-testid="workspace-links" className="flex flex-wrap gap-2">
          {links.map((l) => (
            <Link key={l.label} href={l.href} className="btn btn-sm">
              {l.label}
              {l.count ? <span className="ml-1.5 font-mono text-text-muted">{l.count}</span> : null}
            </Link>
          ))}
        </nav>

        <Lede>{taskCountLede(taskCountMap)}</Lede>

        {/* No repo means workers have nothing to work in; linking one is an admin write. */}
        {!workspace.repo && canManage && <RepoLinkCard workspaceId={workspace.id} />}

        {!hasRunner && (
          <p className="text-sm text-text-muted" data-testid="workspace-no-runner">
            No runner has picked up work here. Set one up in{' '}
            <Link href="/app/settings/runners" className="underline hover:text-text-primary">Settings › Runners</Link>.
          </p>
        )}

        <Section
          title="Recent tasks"
          count={workspace.tasks?.length || undefined}
          action={
            <Link href={`/app/tasks?workspaceId=${workspace.id}`} className="btn btn-sm">
              View all
            </Link>
          }
        >
          {workspace.tasks && workspace.tasks.length > 0 && (
            <ul className="divide-y divide-border-default border-y border-border-default">
              {workspace.tasks.map((task) => (
                <li key={task.id}>
                  <Link href={`/app/tasks/${task.id}`} className="flex min-h-11 items-center justify-between gap-3 py-2 hover:bg-surface-2">
                    <p className="min-w-0 font-medium text-text-primary truncate">{displayTaskTitle(task.title)}</p>
                    <StatusPill status={task.status} />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>
    </main>
  );
}
