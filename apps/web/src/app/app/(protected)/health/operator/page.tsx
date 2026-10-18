import { getUserTeamIds } from '@/lib/team-access';
import { requirePlatformOperator } from '@/lib/operator-page';
import { renderHealthPage } from '../_lib/render-health';
import { loadUsageView } from '../usage/_lib/load-usage-view';
import { UsageInternals } from '../usage/UsageClient';
import { loadKernelOperatorView, parseKernelQuery } from '@/lib/workflow/operator-view';
import { KernelSection } from '../KernelSection';

export const dynamic = 'force-dynamic';

/**
 * `/app/health/operator`: buildd's own tooling (dispatch internals, gates,
 * experiments, delegated work, routing health, orphaned PRs,
 * error-trace patterns, tool usage), the kernel's own log (recent transitions,
 * parked commands, floor runs, one PR's timeline) and, from the Usage drill-down, where agent
 * turns go (code navigation, shell, buildd actions).
 * Platform operators only; everyone else gets a 404, as if the page did not
 * exist. Reads `?workspace=` and `?window=`.
 */
export default async function HealthOperatorPage({ searchParams }: { searchParams: Promise<{ workspace?: string; window?: string; failureWindow?: string; kwindow?: string; kworkspace?: string; kteam?: string; kcommand?: string; kpr?: string }> }) {
  const user = await requirePlatformOperator();
  const params = await searchParams;
  const [health, usage, kernel] = await Promise.all([
    renderHealthPage('operator', Promise.resolve(params)),
    getUserTeamIds(user.id).then(teamIds =>
      teamIds.length === 0
        ? null
        : loadUsageView({ userId: user.id, teamIds, searchParams: { workspace: params.workspace, window: params.window }, includeInternals: true }),
    ).catch(() => null),
    // A failed read leaves the section out; it never takes the page with it.
    loadKernelOperatorView(parseKernelQuery(params)).catch((err) => {
      console.warn('[health] kernel view unavailable:', err instanceof Error ? err.message : err);
      return null;
    }),
  ]);
  return (
    <>
      {health}
      <div className="max-w-2xl mx-auto px-4 pb-24"><KernelSection view={kernel} /></div>
      {usage?.kind === 'ok' && <UsageInternals view={usage.view} />}
    </>
  );
}
