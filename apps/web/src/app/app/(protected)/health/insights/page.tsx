import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getCurrentUser } from '@/lib/auth-helpers';
import { resolveActiveTeamId } from '@/lib/team-access';
import { can } from '@/lib/permissions';
import { isFlowWindow, type FlowWindow } from '@/lib/insights-flow';
import { loadFlowSeries, teamWorkspaceIds } from '@/lib/insights-flow-query';
import { InsightsClient } from './InsightsClient';
import { emptyFlowSeries, resolveInsightsQaState, sampleFlowSeries } from './sample-series';

export const dynamic = 'force-dynamic';

/**
 * `/app/insights`: how the active team's agent work moved to production.
 *
 * For team roles holding `view_team_usage` (admins and owners by default),
 * because it shows every member's work. Anyone else gets a plain explanation,
 * not an empty chart.
 */
export default async function InsightsPage({
  searchParams,
}: {
  searchParams: Promise<{ window?: string; state?: string | string[] }>;
}) {
  const { window: rawWindow, state } = await searchParams;
  const window: FlowWindow = isFlowWindow(rawWindow) ? rawWindow : '7d';

  const user = await getCurrentUser();
  if (!user) redirect('/api/auth/signin');

  const cookieStore = await cookies();
  const teamId = await resolveActiveTeamId(user.id, cookieStore.get('buildd-team')?.value);
  if (!teamId) {
    return (
      <Shell>
        <p className="text-body text-text-muted">
          <Link href="/app/teams/new" className="text-accent-text hover:underline">Create a team</Link>
        </p>
      </Shell>
    );
  }

  const qaState = resolveInsightsQaState(state);
  if (qaState === 'not-admin' || !(await can({ kind: 'user', userId: user.id }, 'view_team_usage', teamId))) {
    return (
      <Shell>
        <div className="card p-4" data-testid="insights-not-allowed">
          <p className="text-body text-text-primary">Team admins only.</p>

        </div>
      </Shell>
    );
  }

  const series = qaState === 'sample'
    ? { ...sampleFlowSeries(window), truncated: false }
    : qaState === 'empty'
      ? { ...emptyFlowSeries(window), truncated: false }
      : await loadFlowSeries(await teamWorkspaceIds(teamId), window);

  return <InsightsClient series={series} window={window} />;
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="max-w-3xl mx-auto px-4 pt-14 pb-24 md:pt-6">
      <h1 className="hidden md:block text-heading font-bold mb-4">Insights</h1>
      {children}
    </div>
  );
}
