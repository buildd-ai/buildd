import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getCurrentUser } from '@/lib/auth-helpers';
import { getUserTeamIds } from '@/lib/team-access';
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
  const loaded = await loadHealth({ page, userId: user.id, teamIds, searchParams: params });
  if (loaded.kind === 'no-workspaces') return <Empty>No workspaces.</Empty>;
  const runnerLanes = page === 'runners' && resolveRunnerLanesSample(params.state)
    ? sampleRunnerLanes(loaded.data.now) : loaded.data.runnerLanes;
  return <HealthClient page={page} {...loaded.data} runnerLanes={runnerLanes} top={top} />;
}
