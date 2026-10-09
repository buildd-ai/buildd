import { describe, it, expect, mock } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

// The page is a client component: the window control is URL state, so
// next/navigation has to exist before the module is imported.
mock.module('next/navigation', () => ({
  useRouter: () => ({ replace: () => {}, refresh: () => {}, push: () => {} }),
  usePathname: () => '/app/health',
  useSearchParams: () => new URLSearchParams(''),
}));

import { HealthClient } from './HealthClient';
import { buildFailureGroups } from '@/lib/health-failure-groups';
import type { RunnerHeartbeat } from '@/lib/runner-heartbeats-shared';
import type { CredentialHealthItem, RecentFailure, ScheduleRow } from './page';

const NOW = Date.now();
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const runner = (over: Partial<RunnerHeartbeat> = {}): RunnerHeartbeat => ({
  id: 'runner-1',
  accountId: 'acct-1',
  accountName: 'Runner one',
  lastHeartbeatAt: ago(3 * HOUR),
  activeWorkerCount: 1,
  maxConcurrentWorkers: 3,
  connectivity: 'reachable',
  sandboxEnabled: true,
  sandboxProbeAt: ago(HOUR),
  mountAllowlistEnforced: true,
  ...over,
});

const failure = (over: Partial<RecentFailure> = {}): RecentFailure => ({
  workerId: 'w-1',
  taskId: 't-1',
  taskTitle: 'A task',
  workspaceName: 'ws',
  error: 'Stale worker expired (no update for 15+ minutes)',
  completedAt: ago(HOUR),
  ...over,
});

const schedule = (over: Partial<ScheduleRow> = {}): ScheduleRow => ({
  id: 's-1',
  workspaceId: 'ws-1',
  workspaceName: 'ws',
  name: 'Nightly sweep',
  cronExpression: '0 3 * * *',
  timezone: 'UTC',
  enabled: true,
  nextRunAt: new Date(NOW + HOUR).toISOString(),
  lastRunAt: ago(HOUR),
  lastError: null,
  consecutiveFailures: 0,
  totalRuns: 412,
  createdAt: ago(90 * DAY),
  taskTitle: 'Sweep',
  missionTitle: null,
  isHeartbeat: false,
  ...over,
});

const credential = (over: Partial<CredentialHealthItem> = {}): CredentialHealthItem => ({
  id: 'cred-1',
  purpose: 'oauth_token',
  healthStatus: 'healthy',
  consecutiveAuthFailures: 0,
  lastFailureAt: null,
  lastFailureMessage: null,
  lastSuccessAt: ago(2 * HOUR),
  lastVerifiedAt: ago(2 * HOUR),
  ...over,
});

const analytics = (over: Record<string, unknown> = {}) => ({
  window: '7d' as const,
  generatedAt: new Date(NOW).toISOString(),
  windowStart: ago(7 * DAY),
  totals: {
    started: 10,
    terminal: 8,
    stillRunning: 2,
    completed: 6,
    failed: 2,
    failureRatePct: 25,
    diedEarly: 1,
    diedEarlySharePct: 50,
  },
  byExitCause: [],
  signatures: [],
  diedEarlySignatures: [],
  byRole: [],
  byWorkspace: [],
  repeatFailureTasks: [],
  ...over,
});

const dist = (v: number) => ({ kind: 'value' as const, value: { mean: v, median: v, p90: v, max: v } });
const unavailable = (reason: string) => ({ kind: 'unavailable' as const, reason });

/** A seat/OAuth-shaped consumption rollup: tokens measured, cost absent. */
const consumption = (over: Record<string, any> = {}): any => ({
  window: '7d',
  scan: { rows: 40, limit: 5000, truncated: false, completeSince: ago(7 * DAY) },
  totals: { tasks: 40, workers: 44, inputTokens: 1_000_000, outputTokens: 5000, costUsd: 0, turns: 300, toolCalls: 900 },
  perTask: {
    tasks: 40,
    contributing: { inputTokens: 40, outputTokens: 40, costUsd: 0, turns: 40, toolCalls: 38 },
    inputTokens: dist(120_000),
    outputTokens: dist(400),
    costUsd: unavailable('Seat-based (OAuth) auth reports no cost'),
    turns: dist(8),
    toolCalls: dist(12),
  },
  tools: {
    coverage: { tasks: 40, histogram: 31, derived: 6, none: 3, histogramRate: 0.775, truncated: 0 },
    byTool: [{ name: 'Bash', calls: 500, share: 0.5, tasks: 20 }],
    byServer: [],
  },
  byModel: [],
  modelDivergence: unavailable('no worker recorded both sides'),
  groupBy: 'role',
  groups: [],
  ...over,
});

const render = (over: Record<string, any> = {}) =>
  renderToStaticMarkup(
    <HealthClient
      orphanedPrs={[]}
      runners={[]}
      usageStats={null}
      consumption={null}
      schedules={[]}
      recentFailures={[]}
      credentialHealth={[]}
      strandedBackends={[]}
      wsFilter={null}
      budgetForecast={null}
      failureAnalytics={null}
      window="7d"
      subagentDelegation={null}
      errorPatterns={null}
      now={NOW}
      {...(over as any)}
    />,
  );



/**
 * Each Health route renders one slice of the sections. These pin the slices,
 * so a section can't silently land on the wrong page (or on none).
 */
const has = (html: string, id: string) => html.includes(`data-testid="${id}"`);

const everything = {
  runners: [runner()],
  credentialHealth: [credential()],
  schedules: [schedule()],
  recentFailures: [failure()],
  failureAnalytics: analytics(),
  failureGroups: { ...buildFailureGroups({ failures: [{ workerId: 'w-1', taskId: 't-1', taskTitle: 'A task', workspaceName: 'ws', error: 'boom', exitCause: 'code_failure', completedAt: ago(HOUR) }], traces: [] }), truncated: false },
  consumption: consumption(),
  usageStats: { total: 5, completed: 4, failed: 1, unassigned: 2 },
  orphanedPrs: [{
    workerId: 'w1', workspaceName: 'ws', taskId: 't1', taskTitle: 'Task', prUrl: null, prNumber: 7,
    reason: 'gone', failureCount: 3, lastCheckedAt: ago(HOUR), prOpenedAt: ago(DAY),
  }],
};

describe('HealthClient — pages', () => {
  it('Overview shows Problems only', () => {
    const html = render({ ...everything, page: 'overview' });
    expect(has(html, 'health-section-problems')).toBe(true);
    for (const id of ['health-section-runners', 'health-section-failure-analytics', 'health-section-consumption', 'health-section-orphaned-prs', 'health-section-task-outcomes']) {
      expect(has(html, id)).toBe(false);
    }
  });

  it('Failures shows the grouped failures, with the window picker', () => {
    const html = render({ ...everything, page: 'failures' });
    expect(has(html, 'health-section-failure-groups')).toBe(true);
    expect(has(html, 'failure-groups-headline')).toBe(true);
    // The raw breakdown lives on Operator now; one failures view per page.
    expect(has(html, 'health-section-failure-analytics')).toBe(false);
    expect(has(html, 'health-section-problems')).toBe(false);
    expect(has(html, 'health-section-consumption')).toBe(false);
    expect(html).toContain('aria-label="Window"');
  });

  it('Runners & capacity shows runners, credentials and schedules, and no window picker', () => {
    const html = render({ ...everything, page: 'runners' });
    for (const id of ['health-section-occupancy', 'health-section-runners', 'health-section-credentials', 'health-section-schedules']) {
      expect(has(html, id)).toBe(true);
    }
    expect(has(html, 'health-section-problems')).toBe(false);
    expect(has(html, 'health-section-failure-analytics')).toBe(false);
    expect(html).not.toContain('aria-label="Window"');
  });

  it('Operator holds the internal tooling and none of the team-facing sections', () => {
    const html = render({ ...everything, page: 'operator' });
    for (const id of ['health-section-consumption', 'health-section-task-outcomes', 'health-section-orphaned-prs', 'health-section-failure-analytics']) {
      expect(has(html, id)).toBe(true);
    }
    for (const id of ['health-section-problems', 'health-section-runners', 'health-section-failure-groups']) {
      expect(has(html, id)).toBe(false);
    }
  });

  it('every section that renders on the single page renders on exactly one route', () => {
    const ids = ['health-section-problems', 'health-section-occupancy', 'health-section-runners', 'health-section-credentials', 'health-section-schedules',
      'health-section-failure-analytics', 'health-section-failure-groups', 'health-section-consumption', 'health-section-task-outcomes', 'health-section-orphaned-prs'];
    const all = render({ ...everything });
    for (const id of ids) {
      expect(has(all, id)).toBe(true);
      const pages = (['overview', 'failures', 'runners', 'operator'] as const).filter(page => has(render({ ...everything, page }), id));
      expect(pages.length).toBe(1);
    }
  });

  it('Overview lists the merged failure groups and links to the Failures page', () => {
    const words = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel'];
    const failures = words.map((w, i) => ({
      workerId: `w${i}`, taskId: `t${i}`, taskTitle: `Task ${w}`, workspaceName: 'ws',
      error: `${w} broke`, exitCause: 'code_failure', completedAt: ago(HOUR),
    }));
    const html = render({
      page: 'overview',
      recentFailures: [],
      failureGroups: { ...buildFailureGroups({ failures, traces: [] }), truncated: false },
    });
    expect(html).toContain('data-testid="top-failure-groups"');
    expect(html).toContain('href="/app/health/failures"');
    // The old 24h signature rows and their overflow line are gone from Overview.
    expect(html).not.toContain('data-testid="problem-failure-group"');
    expect(html).not.toContain('data-testid="problems-denominator"');
  });

  it("Overview's status sentence counts the same failure groups the list shows", () => {
    const one = [{ workerId: 'w1', taskId: 't1', taskTitle: 'T', workspaceName: 'ws', error: 'boom', exitCause: 'code_failure', completedAt: ago(HOUR) }];
    const html = render({
      page: 'overview',
      recentFailures: [],
      runners: [],
      credentialHealth: [],
      failureGroups: { ...buildFailureGroups({ failures: one, traces: [] }), truncated: false },
    });
    // One failure group plus "no runners connected".
    expect(html).toContain('2 things need you.');
  });
});
