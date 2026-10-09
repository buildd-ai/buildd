import { renderHealthPage } from '../_lib/render-health';

export const dynamic = 'force-dynamic';

/** `/app/health/estimates`: Task estimate accuracy & learning curve. Reads `?workspace=`. */
export default async function HealthEstimatesPage({ searchParams }: { searchParams: Promise<{ workspace?: string; window?: string }> }) {
  return renderHealthPage('estimates', searchParams);
}
