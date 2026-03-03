import { db } from '@buildd/core/db';
import { workspaces } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth-helpers';
import { verifyWorkspaceAccess } from '@/lib/team-access';
import { MemoryClient, type Memory } from '@buildd/core/memory-client';
import ObservationList from './ObservationList';

async function fetchInitialMemories(workspaceId: string): Promise<{ memories: Memory[]; total: number }> {
  const url = process.env.MEMORY_API_URL;
  const key = process.env.MEMORY_API_KEY;
  if (!url || !key) return { memories: [], total: 0 };

  try {
    const client = new MemoryClient(url, key);

    // Resolve workspace project scope
    const ws = await db.query.workspaces.findFirst({
      where: eq(workspaces.id, workspaceId),
      columns: { repo: true, name: true },
    });
    const project = ws?.repo || ws?.name || undefined;

    const searchData = await client.search({ project, limit: 50 });
    if (searchData.results.length === 0) return { memories: [], total: 0 };

    const batchData = await client.batch(searchData.results.map(r => r.id));
    return { memories: batchData.memories || [], total: searchData.total };
  } catch {
    return { memories: [], total: 0 };
  }
}

export default async function WorkspaceMemoryPage({
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
    columns: { id: true, name: true },
  });

  if (!workspace) {
    notFound();
  }

  const { memories, total } = await fetchInitialMemories(id);

  return (
    <main className="min-h-screen p-8">
      <div className="max-w-4xl mx-auto">
        <Link href={`/app/workspaces/${id}`} className="text-sm text-text-muted hover:text-text-secondary mb-2 block">
          &larr; {workspace.name}
        </Link>

        <div className="flex justify-between items-start mb-8">
          <div>
            <h1 className="text-3xl font-bold">Memory</h1>
            <p className="text-text-muted mt-1">{total} memories</p>
          </div>
        </div>

        <ObservationList
          workspaceId={id}
          initialObservations={memories.map(m => ({
            id: m.id,
            workspaceId: id,
            workerId: null,
            taskId: null,
            type: m.type,
            title: m.title,
            content: m.content,
            files: m.files || [],
            concepts: m.tags || [],
            createdAt: m.createdAt,
          }))}
        />
      </div>
    </main>
  );
}
