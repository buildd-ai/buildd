import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getCurrentUser } from '@/lib/auth-helpers';
import { resolveActiveTeamId } from '@/lib/team-access';
import { taskEstimatesEnabled } from '@buildd/core/task-estimate-source';
import { fetchLiveEstimateRows } from '@buildd/core/task-estimate-accuracy-source';
import { computeTaskEstimateReadout } from '@buildd/core/task-estimate-accuracy';
import { EstimatesClient } from './EstimatesClient';
import {
  FIXTURE_EMPTY_READOUT, FIXTURE_POINTS, FIXTURE_READOUT, isEstimatesFixtureState,
} from './estimates-fixtures';

export const dynamic = 'force-dynamic';

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="max-w-2xl mx-auto px-4 pt-14 pb-24 md:pt-6">
      <h1 className="hidden md:block text-heading font-bold mb-4">Estimates</h1>
      {children}
    </div>
  );
}

/** `/app/health/estimates`: how close the frozen task estimates were to what the work took. */
export default async function HealthEstimatesPage({ searchParams }: { searchParams?: Promise<{ state?: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect('/api/auth/signin');

  // `?state=` renders static fixture data (after sign-in, before any team lookup) so every variant can be audited.
  const fixture = (await searchParams)?.state;
  if (isEstimatesFixtureState(fixture)) {
    if (fixture === 'error') {
      return (
        <Shell>
          <p className="text-body text-text-muted" role="alert" data-testid="estimates-error">
            Couldn&apos;t load estimate accuracy. Try again in a moment.
          </p>
        </Shell>
      );
    }
    return fixture === 'enabled-empty'
      ? <EstimatesClient readout={FIXTURE_EMPTY_READOUT} points={[]} />
      : <EstimatesClient readout={FIXTURE_READOUT} points={FIXTURE_POINTS} />;
  }

  const cookieStore = await cookies();
  const teamId = await resolveActiveTeamId(user.id, cookieStore.get('buildd-team')?.value);
  if (!teamId) {
    return (
      <Shell>
        <p className="text-body text-text-muted">
          <Link href="/app/teams/new" className="text-accent-text hover:underline">Create a team</Link> to see this page.
        </p>
      </Shell>
    );
  }

  if (!(await taskEstimatesEnabled(teamId))) {
    return (
      <Shell>
        <p className="text-body text-text-muted" data-testid="estimates-off">Task estimates are not turned on for this team.</p>
      </Shell>
    );
  }

  const rows = await fetchLiveEstimateRows(teamId);
  const readout = computeTaskEstimateReadout(rows);
  const points = rows.map(r => ({ estimate: r.p50Minutes, actual: r.actualMinutes, p80: r.p80Minutes }));
  return <EstimatesClient readout={readout} points={points} />;
}
