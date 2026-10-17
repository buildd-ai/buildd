'use client';

/**
 * `?state=runner-isolation`: Health overview and Runners for every row of the
 * runner isolation matrix (runner-isolation-fixtures.ts), with work pending so
 * a stale probe counts. Top: the overview's Problems. Below: each runner's
 * detail, opened where isolation is reduced.
 */
import { HealthClient } from '../../(protected)/health/HealthClient';
import { RUNNER_ISOLATION_FIXTURE_NOW, RUNNER_ISOLATION_ROWS } from './runner-isolation-fixtures';

export default function RunnerIsolationFixture() {
  const common = {
    orphanedPrs: [],
    runners: RUNNER_ISOLATION_ROWS.map(r => r.runner),
    usageStats: null,
    consumption: null,
    schedules: [],
    recentFailures: [],
    credentialHealth: [],
    strandedBackends: [],
    wsFilter: null,
    budgetForecast: null,
    failureAnalytics: null,
    gateAnalytics: null,
    window: '7d' as const,
    subagentDelegation: null,
    errorPatterns: null,
    protectedWorkPending: true,
    now: RUNNER_ISOLATION_FIXTURE_NOW,
  };
  return (
    <main className="min-h-screen">
      <div data-testid="fixture-isolation-overview">
        <HealthClient {...common} page="overview" />
      </div>
      <div data-testid="fixture-isolation-runners" className="border-t border-border-default">
        <HealthClient {...common} page="runners" />
      </div>
    </main>
  );
}
