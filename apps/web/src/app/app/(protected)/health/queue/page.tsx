import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getCurrentUser } from '@/lib/auth-helpers';
import { loadHealthQueueFor } from '@/lib/health-queue-scope';
import QueueClient from './QueueClient';

export const dynamic = 'force-dynamic';

/**
 * `/app/health/queue`: what is waiting across the team, why, and whether it
 * will start (spec "Health › Queue"). Every member of the active team sees
 * it. Reads `?workspace=`, `?mission=`, `?reason=`, `?page=` and `?open=`; the same
 * read backs GET /api/health/queue.
 */
export default async function HealthQueuePage({ searchParams }: { searchParams: Promise<{ workspace?: string; mission?: string; reason?: string; page?: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect('/api/auth/signin');
  const params = await searchParams;
  const now = new Date();
  const loaded = await loadHealthQueueFor(user.id, (await cookies()).get('buildd-team')?.value, params, now);
  if (loaded.kind !== 'ok') {
    return (
      <div className="max-w-2xl mx-auto px-4 pt-14 pb-24 md:pt-6">
        <h1 className="hidden md:block text-heading font-bold mb-2">Queue</h1>
        <p className="text-body text-text-muted">
          {loaded.kind === 'no-team'
            ? <>No team found. <Link href="/app/teams/new" className="text-accent-text hover:underline">Create a team</Link> to see this page.</>
            : 'No workspaces.'}
        </p>
      </div>
    );
  }
  return <QueueClient view={loaded.view} workspaces={loaded.workspaces} workspace={loaded.workspace} mission={loaded.mission} now={now.getTime()} />;
}
