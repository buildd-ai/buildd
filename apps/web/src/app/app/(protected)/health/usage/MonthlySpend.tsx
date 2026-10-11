import type { MonthlyBudgetForecast } from '@/lib/budget-forecast';
import { monthlyAnchor, depletionProjection } from '@/lib/health-metric-grammar';
import { formatEstimatedUsd, ESTIMATED_COST_TITLE } from '@/lib/cost-label';

export function MonthlySpend({ monthly }: { monthly: MonthlyBudgetForecast }) {
  return <section className="mb-6" data-testid="usage-monthly-spend">
    <h2 className="section-label mb-3">Monthly budget · team</h2>
    <div className="border-y border-border-default py-3 space-y-1">
      <p className="text-body text-text-primary tabular-nums" title={ESTIMATED_COST_TITLE}>
        {formatEstimatedUsd(monthly.spentUsd)} / ${monthly.budgetUsd.toFixed(0)}
      </p>
      <p className="text-meta text-text-muted" data-testid="monthly-anchor">{monthlyAnchor(monthly.resetsAt)} · resets {new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(monthly.resetsAt))}</p>
      {depletionProjection(monthly.daysToDepletion, '24h') && <p className="text-meta text-text-muted">{depletionProjection(monthly.daysToDepletion, '24h')}</p>}
      {monthly.confidence !== 'low' && <p className="text-meta text-text-muted">{monthly.confidence === 'high' ? 'Burn rate estimate' : 'Confidence: medium'}</p>}
      <div role="meter" aria-label="Monthly budget used" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.max(0, Math.min(100, monthly.pctUsed))} aria-valuetext={`${monthly.pctUsed}% used`} className="h-1.5 bg-surface-3 overflow-hidden">
        <div className="h-full bg-text-primary" style={{ width: `${Math.max(0, Math.min(100, monthly.pctUsed))}%` }} />
      </div>
    </div>
  </section>;
}
