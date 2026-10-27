import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getCurrentUser } from '@/lib/auth-helpers';
import { loadHealthQueueFor } from '@/lib/health-queue-scope';
import QueueClient from './QueueClient';
import { resolveQueueSample, sampleQueueView } from './sample-queue';

export const dynamic = 'force-dynamic';

/**
 * `/app/health/queue`: what is waiting across the team, why, and whether it
 * will start (spec "Health › Queue"). Every member of the active team sees
 * it. Reads `?workspace=`, `?mission=`, `?reason=` and `?page=`; the same
 * read backs GET /api/health/queue.
 */
export default async function HealthQueuePage({ searchParams }: { searchParams: Promise<{ workspace?: string; mission?: string; reason?: string; page?: string; state?: string | string[] }> }) {
  const user = await getCurrentUser();
  if (!user) redirect('/api/auth/signin');
  const params = await searchParams;
  if (resolveQueueSample(params.state)) {
    return <QueueClient view={sampleQueueView(Date.now())} workspaces={[]} workspace={null} mission={null} />;
  }
  const loaded = await loadHealthQueueFor(user.id, (await cookies()).get('buildd-team')?.value, params);
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
  return <QueueClient view={loaded.view} workspaces={loaded.workspaces} workspace={loaded.workspace} mission={loaded.mission} />;
}
