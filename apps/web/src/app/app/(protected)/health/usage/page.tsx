import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import Link from 'next/link';
import { getCurrentUser } from '@/lib/auth-helpers';
import { getUserTeamIds, resolveActiveTeamScope } from '@/lib/team-access';
import { UsageClient, type HostedRunnerProps } from './UsageClient';
import { loadUsageView } from './_lib/load-usage-view';
import { teamHostedRunnerSummary, workspaceNames } from '@/lib/hosted-runner-usage-store';
import { hostedRunnerMeterView } from '@/lib/hosted-runner-usage';

/**
 * The active team's month on the hosted runner, or null when there is nothing
 * to show (no allowance and no hosted runs: a self-hosted team). Never fails
 * the page.
 */
async function loadHostedRunner(userId: string): Promise<HostedRunnerProps | null> {
  try {
    const cookieStore = await cookies();
    const scope = await resolveActiveTeamScope(userId, cookieStore.get('buildd-team')?.value);
    if (!scope.teamId) return null;
    const now = new Date();
    const summary = await teamHostedRunnerSummary(scope.teamId, now);
    if (summary.allowanceHours === null && summary.rollup.runs === 0) return null;
    const names = await workspaceNames(summary.rollup.workspaces.map(w => w.workspaceId));
    return {
      meter: hostedRunnerMeterView({ allowanceHours: summary.allowanceHours, countedSeconds: summary.rollup.countedSeconds, forecast: summary.forecast }, now),
      rows: summary.rollup.workspaces.map(w => ({
        workspaceId: w.workspaceId,
        name: names.get(w.workspaceId) ?? 'Workspace',
        tasks: w.tasks,
        wallSeconds: w.wallSeconds,
        size: w.size,
        countedSeconds: w.countedSeconds,
      })),
    };
  } catch (err) {
    console.error('[usage] hosted runner summary failed:', err instanceof Error ? err.message : String(err));
    return null;
  }
}

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

  const [loaded, hostedRunner] = await Promise.all([
    loadUsageView({ userId: user.id, teamIds, searchParams: { workspace: wsFilter, window: rawWindow }, includeInternals: false }),
    loadHostedRunner(user.id),
  ]);
  if (loaded.kind === 'no-workspaces') {
    return (
      <div className="max-w-2xl mx-auto p-6">
        <h1 className="hidden md:block text-2xl font-bold mb-2">Usage</h1>
        <p className="text-sm text-text-tertiary">No workspaces.</p>
      </div>
    );
  }

  return <UsageClient view={loaded.view} wsFilter={loaded.wsFilter} hostedRunner={hostedRunner} roleUsage={loaded.roleUsage} monthly={loaded.monthly} />;
}
