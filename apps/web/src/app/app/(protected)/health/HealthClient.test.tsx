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
      runners={[]}
      usageStats={null}
      consumption={null}
      schedules={[]}
      recentFailures={[]}
      credentialHealth={[]}
      strandedBackends={[]}
      teamWorkspaces={[{ id: 'ws-1', name: 'ws' }]}
      wsFilter={null}
      budgetForecast={null}
      failureAnalytics={null}
      window="7d"
      cbm={null}
      {...(over as any)}
    />,
  );

const orderOf = (html: string, ...testids: string[]) =>
  testids.map(id => html.indexOf(`data-testid="${id}"`));

describe('HealthClient — layout', () => {
  it('renders the three sections in Problems → State → Trend order', () => {
    const html = render({ failureAnalytics: analytics() });
    const [problems, state, trend] = orderOf(
      html,
      'health-section-problems',
      'health-section-state',
      'health-section-trend',
    );
    expect(problems).toBeGreaterThan(-1);
    expect(state).toBeGreaterThan(problems);
    expect(trend).toBeGreaterThan(state);
  });

  it('puts capacity, budget, credentials and schedules under State, and the trends after them', () => {
    const html = render({
      runners: [runner()],
      credentialHealth: [credential()],
      schedules: [schedule()],
      failureAnalytics: analytics(),
    });
    const [runners, creds, schedules, failures] = orderOf(
      html,
      'health-section-runners',
      'health-section-credentials',
      'health-section-schedules',
      'health-section-failure-analytics',
    );
    expect(runners).toBeGreaterThan(-1);
    expect(creds).toBeGreaterThan(runners);
    expect(schedules).toBeGreaterThan(creds);
    expect(failures).toBeGreaterThan(schedules);
  });

  it('carries ONE window control, in the header, not one per section', () => {
    const html = render({ failureAnalytics: analytics() });
    expect((html.match(/data-testid="health-window-picker"/g) ?? []).length).toBe(1);
    expect(html).not.toContain('failure-window-picker');
    // The header control precedes every section.
    const [picker, problems] = orderOf(html, 'health-window-picker', 'health-section-problems');
    expect(picker).toBeLessThan(problems);
  });

  it('declares a denominator per section rather than one for the page', () => {
    const html = render({
      runners: [runner()],
      failureAnalytics: analytics(),
      usageStats: { total: 40, completed: 30, failed: 4, unassigned: 6 },
    });
    expect(html).toContain('over 1 runner');
    expect(html).toContain('over 8 terminal worker sessions');
    expect(html).toContain('over 40 tasks');
  });
});

describe('HealthClient — Problems', () => {
  it('flags a fleet whose only problem is degraded sandbox posture', () => {
    // Regression: hasProblems used to omit degradedSandboxRunners entirely, so
    // an unconfined fleet rendered "All systems healthy".
    const html = render({
      runners: [runner({ sandboxEnabled: true, mountAllowlistEnforced: false })],
    });
    expect(html).not.toContain('All systems healthy');
    expect(html).toContain('data-testid="health-section-problems"');
  });

  it('says all systems healthy when nothing is wrong', () => {
    const html = render({ runners: [runner({ lastHeartbeatAt: ago(60 * 1000) })] });
    expect(html).toContain('All systems healthy');
  });

  it('groups failures by error signature instead of listing every row', () => {
    const html = render({
      recentFailures: [
        failure({ workerId: 'a', error: 'Stale worker expired (no update for 15+ minutes)' }),
        failure({ workerId: 'b', error: 'Stale worker expired (no update for 40+ minutes)' }),
        failure({ workerId: 'c', error: 'Deferred: another Codex worker (abc1234) is active' }),
      ],
    });
    expect((html.match(/data-testid="problem-failure-group"/g) ?? []).length).toBe(2);
    expect(html).toContain('Stale worker expired (no update for &lt;n&gt;+ minutes)');
    expect(html).toContain('2×');
  });

  it('caps the group list and counts the remainder in failures', () => {
    const kinds = 'abcdefg';
    const html = render({
      recentFailures: [
        ...Array.from({ length: 7 }, (_, i) =>
          failure({ workerId: `k${i}`, error: `failure kind ${kinds[i]}` }),
        ),
      ],
    });
    expect((html.match(/data-testid="problem-failure-group"/g) ?? []).length).toBe(5);
    expect(html).toContain('+2 more failures in 2 other groups');
  });

  it('labels the recent-failure feed as a fixed 24h, whatever the page window', () => {
    const html = render({ window: '30d', recentFailures: [failure()] });
    expect(html).toContain('last 24h');
    expect(html).toContain('over 1 failed worker');
  });
});

describe('HealthClient — STATE grammar', () => {
  it('renders runner freshness from the heartbeat, not from render time', () => {
    const html = render({ runners: [runner({ lastHeartbeatAt: ago(3 * HOUR) })] });
    expect(html).toContain('as of 3h ago');
  });

  it('renders `never observed` for a credential that was never verified', () => {
    const html = render({
      credentialHealth: [credential({ lastVerifiedAt: null, lastSuccessAt: null })],
    });
    expect(html).toContain('never observed');
  });

  it('renders credential auth failures as a streak, beside the status not merged into it', () => {
    const html = render({
      credentialHealth: [credential({ healthStatus: 'degraded', consecutiveAuthFailures: 4 })],
    });
    expect(html).toContain('4 in a row');
  });
});

describe('HealthClient — LIFETIME grammar', () => {
  // Schedule rows render inside a collapsed panel, so the LIFETIME strings
  // themselves are covered in health-metric-grammar.test.ts. What matters here
  // is that the panel is part of State and not a fourth top-level section.
  it('keeps the schedules panel inside State', () => {
    const html = render({ schedules: [schedule()] });
    const [state, schedules, trend] = orderOf(
      html,
      'health-section-state',
      'health-section-schedules',
      'health-section-trend',
    );
    expect(schedules).toBeGreaterThan(state);
    expect(schedules).toBeLessThan(trend);
  });

  it('anchors monthly budget spend to the calendar month', () => {
    const html = render({
      budgetForecast: {
        oauthSessions: [],
        codex: null,
        missions: [],
        monthly: {
          kind: 'monthly',
          spentUsd: 12.5,
          budgetUsd: 100,
          pctUsed: 13,
          resetsAt: '2026-10-01T00:00:00.000Z',
          burnRateUsdPerDay: 3,
          daysToDepletion: 4.25,
          confidence: 'high',
        },
      },
    });
    expect(html).toContain('since Sep 1');
  });
});

describe('HealthClient — PROJECTION grammar', () => {
  it('states the runway and the window its rate came from in one string', () => {
    const html = render({
      budgetForecast: {
        oauthSessions: [],
        codex: null,
        missions: [],
        monthly: {
          kind: 'monthly',
          spentUsd: 12.5,
          budgetUsd: 100,
          pctUsed: 13,
          resetsAt: '2026-10-01T00:00:00.000Z',
          burnRateUsdPerDay: 3,
          daysToDepletion: 4.25,
          confidence: 'high',
        },
      },
    });
    expect(html).toContain('depletes in 4.3d · from 24h burn');
  });
});

describe('HealthClient — Trend', () => {
  it('divides the failure rate by terminal workers and shows still-running separately', () => {
    const html = render({ failureAnalytics: analytics() });
    expect(html).toContain('2 of 8 terminal');
    expect(html).toContain('Still running');
    expect(html).toContain('as of now');
  });

  it('retires the per-role Usage rollup in favour of a link to /app/team', () => {
    const html = render({
      usageStats: { total: 40, completed: 30, failed: 4, unassigned: 6 },
    });
    expect(html).not.toContain('health-section-usage');
    expect(html).toContain('href="/app/team"');
    expect(html).toContain('per role →');
  });

  it('keeps the two lines /app/team cannot serve, worded task-keyed', () => {
    const html = render({
      window: '30d',
      usageStats: { total: 40, completed: 30, failed: 4, unassigned: 6 },
    });
    expect(html).toContain('30/40 tasks completed (30d)');
    expect(html).toContain('6 tasks ran with no role (30d)');
  });

  it('states the shared seat-auth cause once, without removing the per-stat markers', () => {
    const html = render({ consumption: consumption() });
    expect((html.match(/data-testid="seat-auth-confession"/g) ?? []).length).toBe(1);
    // Per-stat reachability is a separate contract
    // (docs/design/derived-metric-availability.md): the cost tile still renders
    // its own em-dash with its own reason.
    expect(html).toContain('not recorded');
    expect(html).toContain('data-testid="consumption-by-model-absent"');
  });

  it('says nothing about seat auth when every stat is measurable', () => {
    const html = render({
      consumption: consumption({
        perTask: { ...consumption().perTask, costUsd: dist(0.11) },
        byModel: [{ model: 'claude-opus-5', inputTokens: 10, outputTokens: 1, uncachedInputTokens: 10, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 1, workers: 2, share: 1 }],
        modelDivergence: { kind: 'value', value: { rate: 0, diverged: 0, compared: 4, unattributed: 0 } },
      }),
    });
    expect(html).not.toContain('data-testid="seat-auth-confession"');
  });

  it('marks reconstructed tool coverage as a floor, and keeps the scan caveat beside it', () => {
    const html = render({
      consumption: consumption({
        scan: { rows: 5000, limit: 5000, truncated: true, completeSince: ago(2 * DAY) },
      }),
    });
    // ≥ because 6 of the 40 tasks are reconstructed, not measured exactly …
    expect(html).toContain('≥31/40');
    // … and the scan cap is a separate axis that is shown alongside, not folded in.
    expect(html).toContain('data-testid="consumption-scan-caveat"');
  });

  it('drops the CBM adoption ratio but keeps the never-queried alarm', () => {
    const html = render({
      cbm: {
        tracked: 12,
        activeCount: 10,
        adoptionRate: 0,
        totalGraphCalls: 0,
        zeroCallTasks: 10,
        state: 'unused',
        warmStartRate: 1,
        warmStarts: 10,
        indexAttempted: 0,
        indexFailed: 0,
        indexFailureRate: null,
        topIndexFailReason: null,
        eligibleFallbackRate: 0,
        byDesignSkips: {},
        binaryAbsent: 0,
        mountUnavailable: 0,
        avgFileAccessOnActive: 12,
        avgGraphCallsOnActive: 0,
        inputTokenDeltaPct: null,
        fileAccessDeltaPct: null,
        deltasSuppressedBecause: 'no_graph_tool_calls_observed',
        topTools: [],
      },
    });
    expect(html).toContain('Never queried');
    expect(html).toContain('over 10 CBM-enabled sessions');
    // The adoption percentage moves to the usage drill-down; publishing it in two
    // places under two different windows is what the restructure removes.
    expect(html).not.toContain('0% of 10');
  });
});
