import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getCurrentUser } from '@/lib/auth-helpers';
import { resolveActiveTeamId } from '@/lib/team-access';
import { and, eq } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { teamMembers } from '@buildd/core/db/schema';
import { defaultOffReason } from '@buildd/core/task-estimate-rollout';
import { loadTaskEstimatesState } from '@buildd/core/task-estimate-source';
import { roleHas } from '@/lib/permission-registry';
import { EstimatesOff } from './EstimatesOff';
import { fetchLiveEstimateRows } from '@buildd/core/task-estimate-accuracy-source';
import { computeTaskEstimateReadout } from '@buildd/core/task-estimate-accuracy';
import { EstimatesClient } from './EstimatesClient';
import {
  FIXTURE_EMPTY_READOUT, FIXTURE_POINTS, FIXTURE_READOUT, isEstimatesFixtureState,
} from './estimates-fixtures';

export const dynamic = 'force-dynamic';

function LoadError() {
  return (
    <p className="text-body text-text-muted" role="alert" data-testid="estimates-error">
      Couldn&apos;t load estimate accuracy. Try again in a moment.
    </p>
  );
}

/** Whether the viewer may switch the team's features (Settings › Features). A failed read is "no". */
async function canManageTeam(userId: string, teamId: string): Promise<boolean> {
  const m = await db.query.teamMembers.findFirst({
    where: and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)),
    columns: { role: true },
  }).catch(() => null);
  return !!m && roleHas(m.role, 'manage_team_settings');
}

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
    if (fixture === 'error') return <Shell><LoadError /></Shell>;
    if (fixture === 'off-admin' || fixture === 'off-member') {
      return <Shell><EstimatesOff canManage={fixture === 'off-admin'} defaultOffReason={defaultOffReason()} /></Shell>;
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

  const state = await loadTaskEstimatesState(teamId);
  if (state.error) return <Shell><LoadError /></Shell>;
  if (!state.enabled) {
    return (
      <Shell>
        <EstimatesOff canManage={await canManageTeam(user.id, teamId)} defaultOffReason={defaultOffReason()} />
      </Shell>
    );
  }

  const rows = await fetchLiveEstimateRows(teamId).catch((err) => {
    console.warn(`[task-estimate] readout failed for team ${teamId}: ${(err as Error)?.name ?? 'Error'}`);
    return null;
  });
  if (!rows) return <Shell><LoadError /></Shell>;
  const readout = computeTaskEstimateReadout(rows);
  const points = rows.map(r => ({ estimate: r.p50Minutes, actual: r.actualMinutes, p80: r.p80Minutes }));
  return <EstimatesClient readout={readout} points={points} />;
}
