import { renderHealthPage } from './_lib/render-health';

export type {
  ScheduleRow, OrphanedPrRow, UsageStats, ConsumptionGroup, ConsumptionStats, RecentFailure,
  StrandedBackendRow, CredentialHealthItem, BudgetForecast, FailureAnalytics, FailureHeadline, FailureWindow,
  GateAnalytics, SubagentMetrics, SubagentDelegationPanel, ErrorPatternMetrics,
  ErrorPatternPanel,
} from './_lib/health-data';
import { withPageBudget } from '@/lib/page-budget-watch';

export const dynamic = 'force-dynamic';

/** `/app/health`: Overview. What needs attention now. Reads `?workspace=`. */
async function HealthOverviewPage({ searchParams }: { searchParams: Promise<{ workspace?: string; window?: string; failureWindow?: string }> }) {
  return renderHealthPage('overview', searchParams);
}

export default withPageBudget('health', HealthOverviewPage);
