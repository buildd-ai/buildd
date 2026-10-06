import { notFound } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth-helpers';
import { getUserTeamIds } from '@/lib/team-access';
import { isPlatformOperator } from '@/lib/platform-operator';
import { renderHealthPage } from '../_lib/render-health';
import { loadUsageView } from '../usage/_lib/load-usage-view';
import { UsageInternals } from '../usage/UsageClient';

export const dynamic = 'force-dynamic';

/**
 * `/app/health/operator`: buildd's own tooling (dispatch internals, gates,
 * experiments, delegated work, routing health, orphaned PRs,
 * error-trace patterns, tool usage) and, from the Usage drill-down, where agent
 * turns go (code navigation, shell, buildd actions).
 * Platform operators only; everyone else gets a 404, as if the page did not
 * exist. Reads `?workspace=` and `?window=`.
 */
export default async function HealthOperatorPage({ searchParams }: { searchParams: Promise<{ workspace?: string; window?: string; failureWindow?: string }> }) {
  const user = await getCurrentUser();
  if (!isPlatformOperator(user)) notFound();
  const params = await searchParams;
  const [health, usage] = await Promise.all([
    renderHealthPage('operator', Promise.resolve(params)),
    user
      ? getUserTeamIds(user.id).then(teamIds =>
          teamIds.length === 0
            ? null
            : loadUsageView({ userId: user.id, teamIds, searchParams: { workspace: params.workspace, window: params.window }, includeInternals: true }),
        ).catch(() => null)
      : Promise.resolve(null),
  ]);
  return (
    <>
      {health}
      {usage?.kind === 'ok' && <UsageInternals view={usage.view} />}
    </>
  );
}
