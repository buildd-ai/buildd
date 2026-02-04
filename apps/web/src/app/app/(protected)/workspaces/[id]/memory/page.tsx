import { db } from '@buildd/core/db';
import { observations, workspaces } from '@buildd/core/db/schema';
import { eq, and, desc } from 'drizzle-orm';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth-helpers';
import ObservationList from './ObservationList';

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
          <p className="text-gray-500">Development mode - no database</p>
        </div>
      </main>
    );
  }

  if (!user) {
    redirect('/app/auth/signin');
  }

  const workspace = await db.query.workspaces.findFirst({
    where: and(eq(workspaces.id, id), eq(workspaces.ownerId, user.id)),
    columns: { id: true, name: true },
  });

  if (!workspace) {
    notFound();
  }

  const initialObservations = await db
    .select()
    .from(observations)
    .where(eq(observations.workspaceId, id))
    .orderBy(desc(observations.createdAt))
    .limit(50);

  return (
    <main className="min-h-screen p-8">
      <div className="max-w-4xl mx-auto">
        <Link href={`/app/workspaces/${id}`} className="text-sm text-gray-500 hover:text-gray-700 mb-2 block">
          &larr; {workspace.name}
        </Link>

        <div className="flex justify-between items-start mb-8">
          <div>
            <h1 className="text-3xl font-bold">Memory</h1>
            <p className="text-gray-500 mt-1">{initialObservations.length} observations</p>
          </div>
        </div>

        <ObservationList
          workspaceId={id}
          initialObservations={initialObservations.map(o => ({
            ...o,
            createdAt: o.createdAt.toISOString(),
          }))}
        />
      </div>
    </main>
  );
}
