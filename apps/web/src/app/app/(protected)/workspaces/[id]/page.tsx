import { db } from '@buildd/core/db';
import { workspaces, tasks, taskSchedules, workers, artifacts, missions, memories } from '@buildd/core/db/schema';
import { eq, desc, and, count, inArray, notInArray } from 'drizzle-orm';
import { workspaceProjectKey } from '@buildd/core/project-scope';
import Link from 'next/link';
import { NewWorkLink } from '@/components/chat/ChatEntry';
import { notFound, redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth-helpers';
import { verifyWorkspaceAccess } from '@/lib/team-access';
import { roleHas } from '@/lib/permission-registry';
import { RepoLinkCard } from '../../settings/workspace/[workspaceId]/RepoLinkCard';
import { getTeamPermissionOverrides } from '@/lib/permissions';
import { primaryActionClass } from '@/components/ui/PrimaryAction';
import Lede from '@/components/ui/Lede';
import Section from '@/components/ui/Section';
import { StatusPill } from '@/components/ui/StatePill';
import { taskCountLede } from './overview-lede';

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

  const workspace = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, id),
    with: {
      accountWorkspaces: {
        with: {
          account: true,
        },
      },
      tasks: {
        orderBy: desc(tasks.createdAt),
        limit: 5,
      },
    },
  });

  if (!workspace) {
    notFound();
  }

  // Any account that may claim here counts as a runner; the setup lives in Settings › Runners.
  const hasRunner = (workspace.accountWorkspaces || []).some((aw) => aw.account && aw.canClaim);

  const taskCounts = await db
    .select({ status: tasks.status, count: count() })
    .from(tasks)
    .where(eq(tasks.workspaceId, id))
    .groupBy(tasks.status);

  const taskCountMap = Object.fromEntries(taskCounts.map((t) => [t.status, Number(t.count)]));

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

  const [schedCount] = await db
    .select({ count: count() })
    .from(taskSchedules)
    .where(eq(taskSchedules.workspaceId, id));
  const scheduleCount = Number(schedCount?.count || 0);

  const [objCount] = await db
    .select({ count: count() })
    .from(missions)
    .where(eq(missions.workspaceId, id));
  const missionCount = Number(objCount?.count || 0);

  // Count deliverable artifacts (exclude plan types)
  const wsWorkerIds = await db
    .select({ id: workers.id })
    .from(workers)
    .where(eq(workers.workspaceId, id));
  const wIds = wsWorkerIds.map(w => w.id);
  let artifactCount = 0;
  if (wIds.length > 0) {
    const [artCount] = await db
      .select({ count: count() })
      .from(artifacts)
      .where(and(
        inArray(artifacts.workerId, wIds),
        notInArray(artifacts.type, ['impl_plan']),
      ));
    artifactCount = Number(artCount?.count || 0);
  }

  const canManage = roleHas(access.role, 'manage_workspace_settings', await getTeamPermissionOverrides(access.teamId));
  const links: Array<{ href: string; label: string; count?: number }> = [
    { href: `/app/settings/workspace/${workspace.id}`, label: 'Settings' },
    { href: `/app/workspaces/${workspace.id}/memory`, label: 'Memory', count: memoryCount },
    { href: `/app/missions?workspaceId=${workspace.id}`, label: 'Missions', count: missionCount },
    { href: `/app/workspaces/${workspace.id}/schedules`, label: 'Schedules', count: scheduleCount },
    { href: `/app/workspaces/${workspace.id}/artifacts`, label: 'Artifacts', count: artifactCount },
    { href: `/app/health/runners?workspace=${workspace.id}`, label: 'Runners' },
    { href: '/app/settings/roles', label: 'Roles' },
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
            No runner has picked up work here yet. Set one up in{' '}
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
                  <Link href={`/app/tasks/${task.id}`} className="flex items-start justify-between gap-3 py-3 hover:bg-surface-2">
                    <div className="min-w-0">
                      <p className="font-medium text-text-primary truncate">{task.title}</p>
                      {task.description && (
                        <p className="text-sm text-text-muted line-clamp-1">{task.description}</p>
                      )}
                    </div>
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
