import { renderHealthPage } from '../_lib/render-health';

export const dynamic = 'force-dynamic';

/**
 * `/app/health/failures`: Failures: how often work fails, and why, across the
 * active team's workspaces. Reads `?workspace=`.
 */
export default async function HealthFailuresPage({ searchParams }: { searchParams: Promise<{ workspace?: string; window?: string; failureWindow?: string }> }) {
  return renderHealthPage('failures', searchParams);
}
