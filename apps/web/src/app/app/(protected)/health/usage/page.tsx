import { cookies } from 'next/headers';
import Link from 'next/link';
import { requirePlatformOperator } from '@/lib/operator-page';
import { getUserTeamIds, resolveActiveTeamScope } from '@/lib/team-access';
import { UsageClient, type HostedRunnerProps } from './UsageClient';
import { loadUsageView } from './_lib/load-usage-view';
import { loadHostedRunnerMonth } from '@/lib/hosted-runner-usage-store';

/** The active team's month on the hosted runner, or null. Never fails the page. */
async function loadHostedRunner(userId: string): Promise<HostedRunnerProps | null> {
  try {
    const cookieStore = await cookies();
    const scope = await resolveActiveTeamScope(userId, cookieStore.get('buildd-team')?.value);
    return scope.teamId ? await loadHostedRunnerMonth(scope.teamId) : null;
  } catch {
    return null;
  }
}

export const dynamic = 'force-dynamic';

/**
 * `/app/health/usage`: what a task costs. Where the turns go (code navigation,
 * shell, buildd actions) is buildd's own tuning detail and lives
 * on Health → Operator. Platform owner only (it moved to the admin app;
 * a team's spend is on Settings → Billing and budgets); everyone else gets a 404.
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

  const user = await requirePlatformOperator();

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

  // The team's hosted-runner month is team-wide spend: read only for the team view.
  const hostedRunner = loaded.scope === 'team' ? loadHostedRunner(user.id) : null;
  return <UsageClient view={loaded.view} wsFilter={loaded.wsFilter} hostedRunner={await hostedRunner} roleUsage={loaded.roleUsage} monthly={loaded.monthly} scope={loaded.scope} />;
}
