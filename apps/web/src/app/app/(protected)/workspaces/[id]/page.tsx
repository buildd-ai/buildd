import { db } from '@buildd/core/db';
import { workspaces, tasks, accountWorkspaces, observations, taskSchedules, workspaceSkills, workers, artifacts } from '@buildd/core/db/schema';
import { eq, desc, and, count, inArray, notInArray } from 'drizzle-orm';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { ConnectRunnerSection } from './connect-runner';
import DeleteWorkspaceButton from './DeleteWorkspaceButton';
import { getCurrentUser } from '@/lib/auth-helpers';
import { verifyWorkspaceAccess } from '@/lib/team-access';

export default async function WorkspaceDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const isDev = process.env.NODE_ENV === 'development';
  const user = await getCurrentUser();

  if (isDev) {
    return (
      <main className="min-h-screen p-8">
        <div className="max-w-4xl mx-auto">
          <p className="text-text-muted">Development mode - no database</p>
        </div>
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

  const connectedAccounts = workspace.accountWorkspaces || [];
  const runners = {
    action: connectedAccounts.filter((aw) => aw.account?.type === 'action' && aw.canClaim),
    service: connectedAccounts.filter((aw) => aw.account?.type === 'service' && aw.canClaim),
    user: connectedAccounts.filter((aw) => aw.account?.type === 'user' && aw.canClaim),
  };

  const taskCounts = await db
    .select({ status: tasks.status, count: count() })
    .from(tasks)
    .where(eq(tasks.workspaceId, id))
    .groupBy(tasks.status);

  const taskCountMap = Object.fromEntries(taskCounts.map((t) => [t.status, Number(t.count)]));

  const [obsCount] = await db
    .select({ count: count() })
    .from(observations)
    .where(eq(observations.workspaceId, id));
  const observationCount = Number(obsCount?.count || 0);

  const [schedCount] = await db
    .select({ count: count() })
    .from(taskSchedules)
    .where(eq(taskSchedules.workspaceId, id));
  const scheduleCount = Number(schedCount?.count || 0);

  const [skillCount] = await db
    .select({ count: count() })
    .from(workspaceSkills)
    .where(eq(workspaceSkills.workspaceId, id));
  const skillsCount = Number(skillCount?.count || 0);

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

  return (
    <main className="min-h-screen p-8">
      <div className="max-w-4xl mx-auto">
        <Link href="/app/workspaces" className="text-sm text-text-muted hover:text-text-secondary mb-2 block">
          &larr; Workspaces
        </Link>

        <div className="flex justify-between items-start mb-4">
          <div>
            <h1 className="text-[28px] font-semibold tracking-tight text-text-primary">{workspace.name}</h1>
            {workspace.repo && (
              <p className="text-text-muted mt-1">{workspace.repo}</p>
            )}
          </div>
          <div className="flex gap-2">
            <DeleteWorkspaceButton workspaceId={workspace.id} workspaceName={workspace.name} />
            <Link
              href={`/app/tasks/new?workspaceId=${workspace.id}`}
              className="px-4 py-2 bg-primary text-white hover:bg-primary-hover rounded-[10px]"
            >
              + New Task
            </Link>
          </div>
        </div>

        {/* Tab bar */}
        <div className="flex gap-1 border-b border-border-default pb-0 mb-8">
          <Link
            href={`/app/workspaces/${workspace.id}/artifacts`}
            className="px-3 py-2 text-[13px] font-medium text-text-secondary hover:text-text-primary border-b-2 border-transparent hover:border-text-muted -mb-px"
          >
            Artifacts{artifactCount > 0 ? ` (${artifactCount})` : ''}
          </Link>
          <Link
            href={`/app/workspaces/${workspace.id}/schedules`}
            className="px-3 py-2 text-[13px] font-medium text-text-secondary hover:text-text-primary border-b-2 border-transparent hover:border-text-muted -mb-px"
          >
            Schedules{scheduleCount > 0 ? ` (${scheduleCount})` : ''}
          </Link>
          <Link
            href={`/app/workspaces/${workspace.id}/skills`}
            className="px-3 py-2 text-[13px] font-medium text-text-secondary hover:text-text-primary border-b-2 border-transparent hover:border-text-muted -mb-px"
          >
            Skills{skillsCount > 0 ? ` (${skillsCount})` : ''}
          </Link>
          <Link
            href={`/app/workspaces/${workspace.id}/memory`}
            className="px-3 py-2 text-[13px] font-medium text-text-secondary hover:text-text-primary border-b-2 border-transparent hover:border-text-muted -mb-px"
          >
            Memory{observationCount > 0 ? ` (${observationCount})` : ''}
          </Link>
          <Link
            href={`/app/workspaces/${workspace.id}/config`}
            className="px-3 py-2 text-[13px] font-medium text-text-secondary hover:text-text-primary border-b-2 border-transparent hover:border-text-muted -mb-px"
          >
            Configure
          </Link>
        </div>

        {/* Task Stats */}
        <div className="grid grid-cols-4 gap-4 mb-8">
          <div className="bg-surface-2 border border-border-default rounded-[10px] p-4">
            <div className="text-2xl font-semibold">{taskCountMap['pending'] || 0}</div>
            <div className="font-mono text-[10px] uppercase tracking-[1.5px] text-text-muted">Pending</div>
          </div>
          <div className="bg-surface-2 border border-border-default rounded-[10px] p-4">
            <div className="text-2xl font-semibold">{taskCountMap['assigned'] || 0}</div>
            <div className="font-mono text-[10px] uppercase tracking-[1.5px] text-text-muted">Assigned</div>
          </div>
          <div className="bg-surface-2 border border-border-default rounded-[10px] p-4">
            <div className="text-2xl font-semibold">{taskCountMap['completed'] || 0}</div>
            <div className="font-mono text-[10px] uppercase tracking-[1.5px] text-text-muted">Completed</div>
          </div>
          <div className="bg-surface-2 border border-border-default rounded-[10px] p-4">
            <div className="text-2xl font-semibold">{taskCountMap['failed'] || 0}</div>
            <div className="font-mono text-[10px] uppercase tracking-[1.5px] text-text-muted">Failed</div>
          </div>
        </div>

        {/* Runners */}
        <ConnectRunnerSection
          workspaceId={workspace.id}
          workspaceName={workspace.name}
          runners={{
            action: runners.action.map(r => r.account?.name || 'Unknown'),
            service: runners.service.map(r => r.account?.name || 'Unknown'),
            user: runners.user.map(r => r.account?.name || 'Unknown'),
          }}
        />

        {/* Recent Tasks */}
        {workspace.tasks && workspace.tasks.length > 0 && (
          <div>
            <div className="flex justify-between items-center font-mono text-[10px] uppercase tracking-[2.5px] text-text-muted pb-2 border-b border-border-default mb-6">
              <span>Recent Tasks</span>
              <Link href={`/app/tasks?workspaceId=${workspace.id}`} className="text-primary hover:underline normal-case tracking-normal font-sans text-sm">
                View all
              </Link>
            </div>
            <div className="border border-border-default rounded-[10px] divide-y divide-border-default">
              {workspace.tasks.map((task) => (
                <Link
                  key={task.id}
                  href={`/app/tasks/${task.id}`}
                  className="block p-4 hover:bg-surface-3 first:rounded-t-[10px] last:rounded-b-[10px]"
                >
                  <div className="flex justify-between items-start">
                    <div>
                      <h3 className="font-medium">{task.title}</h3>
                      <p className="text-sm text-text-muted line-clamp-1">{task.description}</p>
                    </div>
                    <span className={`px-2 py-1 text-xs rounded-full ${task.status === 'completed' ? 'bg-status-success/10 text-status-success' :
                      task.status === 'failed' ? 'bg-status-error/10 text-status-error' :
                        task.status === 'assigned' ? 'bg-primary/10 text-primary' :
                          'bg-status-warning/10 text-status-warning'
                      }`}>
                      {task.status}
                    </span>
                  </div>
                </Link>
              ))}
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
