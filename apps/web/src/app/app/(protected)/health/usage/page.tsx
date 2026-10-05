import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getCurrentUser } from '@/lib/auth-helpers';
import { getUserTeamIds } from '@/lib/team-access';
import { UsageClient } from './UsageClient';
import { loadUsageView } from './_lib/load-usage-view';

export const dynamic = 'force-dynamic';

/**
 * `/app/health/usage`: what a task costs. Where the turns go (code navigation,
 * shell, buildd actions) is buildd's own tuning detail and lives
 * on Health → Operator.
 *
 * The page is TASK-KEYED — every section reads the `aggregateByTask` fold, so a
 * task retried three times is one task costing the sum of its attempts. The one
 * exception declares itself at the stat (see `indexAdoptionLine`).
 */
export default async function UsageDrilldownPage({
  searchParams,
}: {
  searchParams: Promise<{ workspace?: string; window?: string }>;
}) {
  const { workspace: wsFilter, window: rawWindow } = await searchParams;

  const user = await getCurrentUser();
  if (!user) redirect('/api/auth/signin');

  const teamIds = await getUserTeamIds(user.id);
  if (teamIds.length === 0) {
    return (
      <div className="max-w-2xl mx-auto p-6">
        <h1 className="hidden md:block text-2xl font-bold mb-2">Usage</h1>
        <p className="text-sm text-text-tertiary">No team found. <Link href="/app/teams/new" className="text-primary hover:underline">Create a team</Link> to see this page.</p>
      </div>
    );
  }

  const loaded = await loadUsageView({ userId: user.id, teamIds, searchParams: { workspace: wsFilter, window: rawWindow }, includeInternals: false });
  if (loaded.kind === 'no-workspaces') {
    return (
      <div className="max-w-2xl mx-auto p-6">
        <h1 className="hidden md:block text-2xl font-bold mb-2">Usage</h1>
        <p className="text-sm text-text-tertiary">No workspaces.</p>
      </div>
    );
  }

  return <UsageClient view={loaded.view} wsFilter={loaded.wsFilter} />;
}
