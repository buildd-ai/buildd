import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getCurrentUser } from '@/lib/auth-helpers';
import { resolveActiveTeamId } from '@/lib/team-access';
import { loadTaskEstimatesState } from '@buildd/core/task-estimate-source';
import { EstimatesOff } from './EstimatesOff';
import { fetchLiveEstimateRows } from '@buildd/core/task-estimate-accuracy-source';
import { computeTaskEstimateReadout } from '@buildd/core/task-estimate-accuracy';
import { EstimatesClient } from './EstimatesClient';
import { FIXTURE_READOUTS, isEstimatesFixtureState } from './estimates-fixtures';

export const dynamic = 'force-dynamic';

function LoadError() {
  return (
    <p className="text-body text-text-muted" role="alert" data-testid="estimates-error">
      Couldn&apos;t load estimate accuracy. Try again in a moment.
    </p>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="max-w-2xl mx-auto px-4 pt-14 pb-24 md:pt-6">
      <h1 className="hidden md:block text-heading font-bold mb-4">Estimates</h1>
      {children}
    </div>
  );
}

/** `/app/health/estimates`: how often finished tasks landed within their upper estimate. */
export default async function HealthEstimatesPage({ searchParams }: { searchParams?: Promise<{ state?: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect('/api/auth/signin');

  // `?state=` renders static fixture data (after sign-in, before any team lookup) so every variant can be audited.
  const fixture = (await searchParams)?.state;
  if (isEstimatesFixtureState(fixture)) {
    if (fixture === 'error') return <Shell><LoadError /></Shell>;
    if (fixture === 'off-admin' || fixture === 'off-member') {
      return <Shell><EstimatesOff /></Shell>;
    }
    return <EstimatesClient readout={FIXTURE_READOUTS[fixture]} />;
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

  const state = await loadTaskEstimatesState(teamId);
  if (state.error) return <Shell><LoadError /></Shell>;
  if (!state.enabled) {
    return (
      <Shell>
        <EstimatesOff />
      </Shell>
    );
  }

  const rows = await fetchLiveEstimateRows(teamId).catch((err) => {
    console.warn(`[task-estimate] readout failed for team ${teamId}: ${(err as Error)?.name ?? 'Error'}`);
    return null;
  });
  if (!rows) return <Shell><LoadError /></Shell>;
  return <EstimatesClient readout={computeTaskEstimateReadout(rows)} />;
}
