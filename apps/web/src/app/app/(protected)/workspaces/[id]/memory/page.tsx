import { db } from '@buildd/core/db';
import { workspaces } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth-helpers';
import { verifyWorkspaceAccess } from '@/lib/team-access';
import type { Memory } from '@buildd/core/memory-store';
import { getMemoryStoreForTeam } from '@/lib/memory-helper';
import { workspaceProjectKey } from '@buildd/core/project-scope';
import ObservationList from './ObservationList';
import KnowledgeHealthSection from './KnowledgeHealthSection';
import { roleHas } from '@/lib/permission-registry';
import { getTeamPermissionOverrides } from '@/lib/permissions';

async function fetchInitialMemories(workspaceId: string): Promise<{ memories: Memory[]; total: number }> {
  try {
    const client = await getMemoryStoreForTeam(workspaceId);
    if (!client) return { memories: [], total: 0 };

    // Resolve workspace project scope, canonicalized to the same `owner/repo`
    // key the memories rows carry (workspaces.repo is a mix of full URLs and
    // short forms, so the raw value scoped nothing).
    const ws = await db.query.workspaces.findFirst({
      where: eq(workspaces.id, workspaceId),
      columns: { repo: true, name: true },
    });
    const project = workspaceProjectKey(ws?.repo, ws?.name) ?? undefined;

    // Every state, superseded rows included: the page labels each one.
    const searchData = await client.search({ project, limit: 50, includeSuperseded: true });
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
    columns: { id: true, name: true },
  });

  if (!workspace) {
    notFound();
  }

  const { memories, total } = await fetchInitialMemories(id);

  return (
    <main className="pt-[4.5rem] px-4 pb-24 md:px-8 md:pt-8 md:pb-10">
      <div className="max-w-4xl space-y-8">
        <header>
          <h1 className="hidden md:block text-xl font-semibold text-text-primary">Memory</h1>
          <p className="text-sm text-text-secondary md:mt-1.5">
            <span className="font-mono">{total}</span> {total === 1 ? 'memory' : 'memories'} in{' '}
            <Link href={`/app/workspaces/${id}`} className="underline hover:text-text-primary">{workspace.name}</Link>
          </p>
        </header>

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
            state: m.state ?? null,
            supersededBy: m.supersededBy ?? null,
            reverifyFlaggedAt: m.reverifyFlaggedAt ?? null,
            reverifyRef: m.reverifyRef ?? null,
          }))}
          canReview={roleHas(access.role, 'review_memory', await getTeamPermissionOverrides(access.teamId))}
        />
        <KnowledgeHealthSection workspaceId={id} />
      </div>
    </main>
  );
}
