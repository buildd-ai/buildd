import { db } from '@buildd/core/db';
import { workspaces, taskSchedules } from '@buildd/core/db/schema';
import { eq, desc } from 'drizzle-orm';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth-helpers';
import { verifyWorkspaceAccess } from '@/lib/team-access';
import { ScheduleList } from './ScheduleList';
import { ScheduleForm } from './ScheduleForm';

export default async function SchedulesPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ new?: string }>;
}) {
  const { id } = await params;
  const query = await searchParams;
  const showNew = query.new === '1';

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

  const schedules = await db.query.taskSchedules.findMany({
    where: eq(taskSchedules.workspaceId, id),
    orderBy: [desc(taskSchedules.createdAt)],
  });

  return (
    <main className="min-h-screen p-8">
      <div className="max-w-4xl mx-auto">
        <Link href={`/app/workspaces/${id}`} className="text-sm text-text-muted hover:text-text-secondary mb-2 block">
          &larr; {workspace.name}
        </Link>

        <div className="flex justify-between items-center mb-8">
          <div>
            <h1 className="text-3xl font-bold">Schedules</h1>
            <p className="text-text-muted mt-1">
              {schedules.length} schedule{schedules.length !== 1 ? 's' : ''}
            </p>
          </div>
          {!showNew && (
            <Link
              href={`/app/workspaces/${id}/schedules?new=1`}
              className="px-4 py-2 bg-primary text-white hover:bg-primary-hover rounded-lg"
            >
              + New Schedule
            </Link>
          )}
        </div>

        {showNew && (
          <div className="mb-8">
            <ScheduleForm workspaceId={id} />
          </div>
        )}

        <ScheduleList workspaceId={id} initialSchedules={JSON.parse(JSON.stringify(schedules))} />
      </div>
    </main>
  );
}
