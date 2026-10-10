import { requirePlatformOperator } from '@/lib/operator-page';
import { renderHealthPage } from '../_lib/render-health';

export const dynamic = 'force-dynamic';

/**
 * `/app/health/failures`: Failures: how often work fails, and why. Reads `?workspace=`.
 * Platform owner only (it moved to the admin app); everyone else gets a 404.
 */
export default async function HealthFailuresPage({ searchParams }: { searchParams: Promise<{ workspace?: string; window?: string; failureWindow?: string }> }) {
  await requirePlatformOperator();
  return renderHealthPage('failures', searchParams);
}
