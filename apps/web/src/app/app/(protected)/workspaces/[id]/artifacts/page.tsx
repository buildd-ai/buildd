import { db } from '@buildd/core/db';
import { workspaces, artifacts, workers, tasks } from '@buildd/core/db/schema';
import { eq, desc, inArray } from 'drizzle-orm';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth-helpers';
import { verifyWorkspaceAccess } from '@/lib/team-access';
import ArtifactList from '@/components/ArtifactList';

export const dynamic = 'force-dynamic';

export default async function WorkspaceArtifactsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user = await getCurrentUser();

  if (!user) {
    redirect('/app/auth/signin');
  }

  const access = await verifyWorkspaceAccess(user.id, id);
  if (!access) notFound();

  const workspace = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, id),
    columns: { id: true, name: true },
  });

  if (!workspace) {
    notFound();
  }

  // Get all workers in this workspace
  const workspaceWorkers = await db.query.workers.findMany({
    where: eq(workers.workspaceId, id),
    columns: { id: true, taskId: true },
  });

  const workerIds = workspaceWorkers.map(w => w.id);

  // Get artifacts for those workers, excluding plan types
  const allArtifacts = workerIds.length > 0
    ? await db.query.artifacts.findMany({
        where: inArray(artifacts.workerId, workerIds),
        orderBy: desc(artifacts.createdAt),
      })
    : [];

  const deliverableArtifacts = allArtifacts.filter(
    a => a.type !== 'task_plan' && a.type !== 'impl_plan'
  );

  // Build worker→task mapping for task titles
  const taskIds = [...new Set(workspaceWorkers.filter(w => w.taskId).map(w => w.taskId!))];
  const taskMap = new Map<string, { id: string; title: string }>();
  if (taskIds.length > 0) {
    const taskRows = await db.query.tasks.findMany({
      where: inArray(tasks.id, taskIds),
      columns: { id: true, title: true },
    });
    for (const t of taskRows) {
      taskMap.set(t.id, t);
    }
  }

  const workerTaskMap = new Map<string, string>();
  for (const w of workspaceWorkers) {
    if (w.taskId) workerTaskMap.set(w.id, w.taskId);
  }

  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://buildd.dev';

  const artifactItems = deliverableArtifacts.map(a => {
    const taskId = workerTaskMap.get(a.workerId) || null;
    const task = taskId ? taskMap.get(taskId) : null;
    return {
      id: a.id,
      type: a.type,
      title: a.title,
      content: a.content,
      shareToken: a.shareToken,
      metadata: (a.metadata || {}) as Record<string, unknown>,
      createdAt: a.createdAt.toISOString(),
      taskTitle: task?.title || null,
      taskId: task?.id || null,
      workspaceName: null,
    };
  });

  return (
    <main className="min-h-screen p-4 md:p-8">
      <div className="max-w-4xl mx-auto">
        <Link href={`/app/workspaces/${id}`} className="text-sm text-text-muted hover:text-text-secondary mb-2 block">
          &larr; {workspace.name}
        </Link>

        <div className="flex justify-between items-center mb-8">
          <div>
            <h1 className="text-3xl font-bold">Artifacts</h1>
            <p className="text-text-muted mt-1">
              {deliverableArtifacts.length} artifact{deliverableArtifacts.length !== 1 ? 's' : ''}
            </p>
          </div>
        </div>

        <ArtifactList
          artifacts={artifactItems}
          baseUrl={baseUrl}
        />
      </div>
    </main>
  );
}
