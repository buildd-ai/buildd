import { renderHealthPage } from '../_lib/render-health';

export const dynamic = 'force-dynamic';

/** `/app/health/runners`: Runners & capacity: slots in use, runners, budget and credentials. Reads `?workspace=`. */
export default async function HealthRunnersPage({ searchParams }: { searchParams: Promise<{ workspace?: string; window?: string; failureWindow?: string }> }) {
  return renderHealthPage('runners', searchParams);
}
