import { db } from '@buildd/core/db';
import { workspaces, taskSchedules } from '@buildd/core/db/schema';
import { eq, desc } from 'drizzle-orm';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth-helpers';
import { verifyWorkspaceAccess } from '@/lib/team-access';
import { ScheduleList } from './ScheduleList';
import { ScheduleForm } from './ScheduleForm';
import PrimaryAction from '@/components/ui/PrimaryAction';

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

  const schedules = await db.query.taskSchedules.findMany({
    where: eq(taskSchedules.workspaceId, id),
    orderBy: [desc(taskSchedules.createdAt)],
  });

  return (
    <main className="pt-[4.5rem] px-4 pb-24 md:px-8 md:pt-8 md:pb-10">
      <div className="max-w-4xl space-y-8">
        <header className="flex flex-wrap justify-between items-start gap-3">
          <div className="min-w-0">
            <h1 className="hidden md:block text-xl font-semibold text-text-primary">Schedules</h1>
            <p className="text-sm text-text-secondary md:mt-1.5 [overflow-wrap:anywhere]">
              <span className="font-mono">{schedules.length}</span> schedule{schedules.length !== 1 ? 's' : ''} in{' '}
              <Link href={`/app/workspaces/${id}`} className="underline hover:text-text-primary">{workspace.name}</Link>.{' '}
              <Link href="/app/schedules" className="underline hover:text-text-primary">
                See all automation
              </Link>
            </p>
          </div>
          {!showNew && (
            <PrimaryAction href={`/app/workspaces/${id}/schedules?new=1`} className="shrink-0">
              New schedule
            </PrimaryAction>
          )}
        </header>

        {showNew && <ScheduleForm workspaceId={id} />}

        <ScheduleList workspaceId={id} initialSchedules={JSON.parse(JSON.stringify(schedules))} />
      </div>
    </main>
  );
}
