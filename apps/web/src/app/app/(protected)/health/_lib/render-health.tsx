import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getCurrentUser } from '@/lib/auth-helpers';
import { isPlatformOperator } from '@/lib/platform-operator';
import { cookies } from 'next/headers';
import { getUserTeamIds, resolveActiveTeamId } from '@/lib/team-access';
import { loadServiceStatus } from '@/lib/service-status-loader';
import { ServiceStatusBanner, ServiceStatusList } from '@/components/service-status/ServiceStatusList';
import { HealthClient } from '../HealthClient';
import { sampleRunnerLanes, resolveRunnerLanesSample } from '../runners/sample-lanes';
import { loadHealth, type HealthPageKey } from './health-data';

export type HealthSearchParams = Promise<{ workspace?: string; window?: string; failureWindow?: string; state?: string | string[] }>;

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="max-w-2xl mx-auto p-6">
      <h1 className="hidden md:block text-2xl font-bold mb-2">Health</h1>
      <p className="text-sm text-text-tertiary">{children}</p>
    </div>
  );
}

/** Shared body of every Health page: auth, team, the page's data, its sections. */
export async function renderHealthPage(page: HealthPageKey, searchParams: HealthSearchParams, top?: React.ReactNode) {
  const user = await getCurrentUser();
  if (!user) redirect('/api/auth/signin');

  const teamIds = await getUserTeamIds(user.id);
  if (teamIds.length === 0) {
    return <Empty>No team found. <Link href="/app/teams/new" className="text-primary hover:underline">Create a team</Link> to see this page.</Empty>;
  }

  const params = await searchParams;
  const cookieStore = await cookies();
  const activeTeamId = (await resolveActiveTeamId(user.id, cookieStore.get('buildd-team')?.value).catch(() => null)) ?? teamIds[0];
  // Service status reads alongside the page's data; a failed read renders the page without it.
  const [loaded, status] = await Promise.all([
    loadHealth({ page, userId: user.id, teamIds, searchParams: params, operator: isPlatformOperator(user) }),
    loadServiceStatus({ userId: user.id, teamId: activeTeamId }),
  ]);
  if (loaded.kind === 'no-workspaces') return <Empty>No workspaces.</Empty>;
  const runnerLanes = page === 'runners' && resolveRunnerLanesSample(params.state)
    ? sampleRunnerLanes(loaded.data.now) : loaded.data.runnerLanes;
  // The banner on every Health page; the quiet list on Overview, where "what needs attention now" lives.
  const statusTop = (
    <>
      {status.banner && <ServiceStatusBanner status={status.banner} />}
      {page === 'overview' && <ServiceStatusList statuses={status.statuses} />}
      {top}
    </>
  );
  return <HealthClient page={page} {...loaded.data} runnerLanes={runnerLanes} top={statusTop} />;
}
