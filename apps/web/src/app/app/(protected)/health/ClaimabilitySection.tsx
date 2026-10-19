/**
 * Claimability on /app/health/runners: what the claim planner recorded, kept
 * apart from slot occupancy above it. Pure render over the ledger summary
 * (lib/claim-plan-health.ts); it states no slot ceiling and no history of one.
 */
import { Stat } from '@/components/StatTile';
import { formatDuration } from '@buildd/core/dispatch-health-report';
import type { ClaimPlanHealth } from '@/lib/claim-plan-health';

export function ClaimabilitySection({ health, now }: { health: ClaimPlanHealth | null; now: number }) {
  if (!health) return null;
  const evaluated = health.lastEvaluatedAt ? `${formatDuration(Math.max(0, now - Date.parse(health.lastEvaluatedAt)))} ago` : null;
  return (
    <div data-testid="health-section-claimability" className="mb-6">
      <h3 className="text-xs font-medium text-text-secondary mb-1">Claimability</h3>
      <p className="text-meta text-text-muted mb-3">
        What the scheduler could start, from its recorded plans. Separate from slots in use: workspace limits,
        entitlements and provider capacity also decide what starts.
      </p>
      {health.plans === 0 ? (
        <p data-testid="claimability-empty" className="text-xs text-text-muted">
          No claim plans recorded in this window. Claimability unknown.
        </p>
      ) : (
        <div className="card p-4 space-y-3">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Plans" value={String(health.plans)} sub={`${health.mode === 'apply' ? 'applied' : 'record only'}, last ${evaluated}`} />
            <Stat label="Ordered behind" value={String(health.plansWithOrdering)} sub="plans holding a task back" />
            <Stat label="Under pressure" value={String(health.plansUnderPressure)} sub="budget or plan limits" />
            <Stat
              label="Work left unstarted"
              value={String(health.plansLeavingClaimableWork)}
              sub={health.plansWithoutCapacity > 0 ? `${health.plansWithoutCapacity} plans carry no capacity` : 'picks below what was claimable'}
            />
          </div>
          <p className="text-xs text-text-secondary tabular-nums">
            <span className="text-text-muted">By backend</span> claude {health.byBackend.claude}, codex {health.byBackend.codex}
            {health.byBackend.mixed > 0 ? `, mixed ${health.byBackend.mixed}` : ''}
          </p>
        </div>
      )}
    </div>
  );
}
