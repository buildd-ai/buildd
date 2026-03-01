import { db } from '@buildd/core/db';
import { workspaces, artifacts, workers, tasks } from '@buildd/core/db/schema';
import { desc, inArray } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth-helpers';
import { getUserWorkspaceIds } from '@/lib/team-access';
import ArtifactList from '@/components/ArtifactList';

export const dynamic = 'force-dynamic';

export default async function ArtifactsPage() {
  const user = await getCurrentUser();

  if (!user) {
    redirect('/app/auth/signin');
  }

  // Get all workspace IDs the user has access to
  const wsIds = await getUserWorkspaceIds(user.id);

  if (wsIds.length === 0) {
    return (
      <main className="min-h-screen pt-14 px-4 pb-4 md:p-8">
        <div className="max-w-4xl mx-auto">
          <h1 className="text-2xl font-semibold mb-2">Artifacts</h1>
          <p className="text-text-muted">No workspaces found. Create a workspace to get started.</p>
        </div>
      </main>
    );
  }

  // Get workspace names for display
  const userWorkspaces = await db.query.workspaces.findMany({
    where: inArray(workspaces.id, wsIds),
    columns: { id: true, name: true },
  });
  const wsNameMap = new Map(userWorkspaces.map(w => [w.id, w.name]));

  // Get all workers across user's workspaces
  const allWorkers = await db.query.workers.findMany({
    where: inArray(workers.workspaceId, wsIds),
    columns: { id: true, taskId: true, workspaceId: true },
  });

  const workerIds = allWorkers.map(w => w.id);

  // Get artifacts, excluding plan types
  const allArtifacts = workerIds.length > 0
    ? await db.query.artifacts.findMany({
        where: inArray(artifacts.workerId, workerIds),
        orderBy: desc(artifacts.createdAt),
      })
    : [];

  const deliverableArtifacts = allArtifacts.filter(
    a => a.type !== 'impl_plan'
  );

  // Build mappings
  const taskIds = [...new Set(allWorkers.filter(w => w.taskId).map(w => w.taskId!))];
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

  const workerMeta = new Map<string, { taskId: string | null; workspaceId: string }>();
  for (const w of allWorkers) {
    workerMeta.set(w.id, { taskId: w.taskId, workspaceId: w.workspaceId });
  }

  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://buildd.dev';

  const artifactItems = deliverableArtifacts.map(a => {
    const meta = workerMeta.get(a.workerId);
    const taskId = meta?.taskId || null;
    const task = taskId ? taskMap.get(taskId) : null;
    const workspaceName = meta?.workspaceId ? wsNameMap.get(meta.workspaceId) || null : null;
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
      workspaceName,
    };
  });

  return (
    <main className="min-h-screen pt-14 px-4 pb-4 md:p-8">
      <div className="max-w-4xl mx-auto">
        <div className="flex justify-between items-center mb-8">
          <div>
            <h1 className="text-2xl font-semibold">Artifacts</h1>
            <p className="text-text-muted mt-1">
              {deliverableArtifacts.length} artifact{deliverableArtifacts.length !== 1 ? 's' : ''} across {userWorkspaces.length} workspace{userWorkspaces.length !== 1 ? 's' : ''}
            </p>
          </div>
        </div>

        <ArtifactList
          artifacts={artifactItems}
          showWorkspace
          baseUrl={baseUrl}
        />
      </div>
    </main>
  );
}
