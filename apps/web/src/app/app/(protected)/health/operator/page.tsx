import { notFound } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth-helpers';
import { isPlatformOperator } from '@/lib/platform-operator';
import { renderHealthPage } from '../_lib/render-health';

export const dynamic = 'force-dynamic';

/**
 * `/app/health/operator`: buildd's own tooling (dispatch internals, gates,
 * experiments, codebase graph, delegated work, routing health, orphaned PRs,
 * error-trace patterns, tool usage). Platform operators only; everyone else
 * gets a 404, as if the page did not exist. Reads `?workspace=`.
 */
export default async function HealthOperatorPage({ searchParams }: { searchParams: Promise<{ workspace?: string; window?: string; failureWindow?: string }> }) {
  const user = await getCurrentUser();
  if (!isPlatformOperator(user)) notFound();
  return renderHealthPage('operator', searchParams);
}
