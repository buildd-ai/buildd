import { renderHealthPage } from './_lib/render-health';

export type {
  ScheduleRow, OrphanedPrRow, UsageStats, ConsumptionGroup, ConsumptionStats, RecentFailure,
  StrandedBackendRow, CredentialHealthItem, BudgetForecast, FailureAnalytics, FailureWindow,
  GateAnalytics, CbmHealthSummary, SubagentMetrics, SubagentDelegationPanel, ErrorPatternMetrics,
  ErrorPatternPanel,
} from './_lib/health-data';

export const dynamic = 'force-dynamic';

/** `/app/health`: Overview. What needs attention now. Reads `?workspace=`. */
export default async function HealthOverviewPage({ searchParams }: { searchParams: Promise<{ workspace?: string; window?: string; failureWindow?: string }> }) {
  return renderHealthPage('overview', searchParams);
}
