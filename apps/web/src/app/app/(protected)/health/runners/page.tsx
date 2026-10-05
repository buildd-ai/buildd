import { renderHealthPage } from '../_lib/render-health';

export const dynamic = 'force-dynamic';

/** `/app/health/runners`: Runners & capacity: runners, credentials, budget and schedules. Reads `?workspace=`. */
export default async function HealthRunnersPage({ searchParams }: { searchParams: Promise<{ workspace?: string; window?: string; failureWindow?: string }> }) {
  return renderHealthPage('runners', searchParams);
}
