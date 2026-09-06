import { describe, it, expect, mock } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

// The route is a client component: the window control is URL state, so
// next/navigation has to exist before the module is imported.
mock.module('next/navigation', () => ({
  useRouter: () => ({ replace: () => {}, refresh: () => {}, push: () => {} }),
  usePathname: () => '/app/health/usage',
  useSearchParams: () => new URLSearchParams(''),
}));

import { UsageClient } from './UsageClient';
import { computeUsageStats, type UsageWorkerRow } from '@/lib/usage-stats';
import type { CbmHealthSummary } from '@/lib/cbm-insight';
import {
  buildActionBreakdownPanel,
  buildUsageDrilldownView,
  resolveDrilldownWindow,
  type PreviousPeriod,
} from '@/lib/usage-drilldown';

const worker = (over: Partial<UsageWorkerRow> & { counts?: Record<string, number> } = {}): UsageWorkerRow => {
  const { counts, ...rest } = over;
  return {
    workerId: 'w-1',
    completedAt: new Date('2026-09-01T00:00:00Z'),
    taskId: 't-1',
    parentTaskId: null,
    workspaceId: 'ws-1',
    taskStatus: 'completed',
    roleSlug: 'builder',
    inputTokens: 120_000,
    outputTokens: 4_000,
    // Seat/OAuth auth: no cost is reported at all.
    costUsd: null,
    turns: 12,
    resultMeta: { toolCounts: counts ?? { Read: 10, Grep: 3, Bash: 8 } } as any,
    mcpCalls: null,
    ...rest,
  };
};

const cbm = (over: Partial<CbmHealthSummary> = {}): CbmHealthSummary => ({
  tracked: 20,
  activeCount: 16,
  adoptionRate: 0.5,
  totalGraphCalls: 40,
  zeroCallTasks: 8,
  state: 'partial',
  warmStartRate: 1,
  warmStarts: 16,
  indexAttempted: 0,
  indexFailed: 0,
  indexFailureRate: null,
  topIndexFailReason: null,
  eligibleFallbackRate: 0,
  byDesignSkips: {},
  binaryAbsent: 0,
  mountUnavailable: 0,
  avgFileAccessOnActive: 12,
  avgGraphCallsOnActive: 2.5,
  inputTokenDeltaPct: null,
  fileAccessDeltaPct: null,
  deltasSuppressedBecause: null,
  topTools: [],
  ...over,
});

const rows = (n: number, counts?: Record<string, number>) =>
  Array.from({ length: n }, (_, i) => worker({ workerId: `w${i}`, taskId: `t-${i}`, counts }));

const view = (over: {
  window?: string | null;
  rows?: UsageWorkerRow[];
  previous?: PreviousPeriod | null;
  cbm?: CbmHealthSummary | null;
  truncated?: boolean;
  actions?: Parameters<typeof buildUsageDrilldownView>[0]['actions'];
} = {}) =>
  buildUsageDrilldownView({
    resolution: resolveDrilldownWindow(over.window ?? '7d'),
    current: computeUsageStats(over.rows ?? rows(8), 'none'),
    previous: over.previous ?? null,
    scan: {
      rows: (over.rows ?? rows(8)).length,
      limit: 5000,
      truncated: over.truncated ?? false,
      completeSince: '2026-08-27T00:00:00.000Z',
    },
    cbm: over.cbm === undefined ? cbm() : over.cbm,
    actions: over.actions === undefined ? actionPanel() : over.actions,
  });

/** Default action panel: captured window, a few actions, full coverage. */
const actionPanel = (over: Partial<Parameters<typeof buildActionBreakdownPanel>[0]> = {}) =>
  buildActionBreakdownPanel({
    rows: [
      { workerId: 'w1', action: 'update_progress' },
      { workerId: 'w1', action: 'update_progress' },
      { workerId: 'w2', action: 'claim_task' },
    ],
    workers: 4,
    windowStart: new Date('2026-09-05T00:00:00Z'),
    capturedSince: '2026-09-03',
    rowLimit: 5000,
    ...over,
  });

const render = (over: Parameters<typeof view>[0] = {}, wsFilter: string | null = null) =>
  renderToStaticMarkup(
    <UsageClient
      view={view(over)}
      teamWorkspaces={[{ id: 'ws-1', name: 'ws' }]}
      wsFilter={wsFilter}
    />,
  );

describe('UsageClient — header', () => {
  it('is task-keyed: the denominator counts tasks, folding a task’s attempts into one', () => {
    const html = render({
      rows: [
        worker({ workerId: 'a', taskId: 't-1' }),
        worker({ workerId: 'b', taskId: 't-1' }),
        worker({ workerId: 'c', taskId: 't-2' }),
      ],
    });
    expect(html).toContain('over 2 tasks (7d)');
    expect(html).not.toContain('worker sessions (7d)');
  });

  it('clamps a 24h entry to 7d with a visible notice', () => {
    const html = render({ window: '24h' });
    expect(html).toContain('data-testid="usage-clamp-notice"');
    expect(html).toContain('24h is too thin for stable percentages here');
    expect(html).toContain('over 8 tasks (7d)');
  });

  it('sends you back to Health at 24h, unclamped — the clamp does not follow you out', () => {
    const html = render({ window: '24h' }, 'ws-1');
    expect(html).toContain('href="/app/health?window=24h&amp;workspace=ws-1"');
  });

  it('offers 7d and 30d only — there is no 24h control to mislead with', () => {
    const html = render({ window: '30d' });
    expect(html).toContain('data-testid="usage-window-picker"');
    const picker = html.slice(html.indexOf('data-testid="usage-window-picker"'));
    const buttons = picker.slice(0, picker.indexOf('</div>'));
    expect(buttons).not.toContain('24h');
  });

  it('says nothing at all rather than dividing by zero when the window is empty', () => {
    const html = render({ rows: [] });
    expect(html).toContain('data-testid="usage-empty"');
    expect(html).not.toContain('data-testid="usage-section-code-nav"');
  });
});

describe('UsageClient — per-task cost', () => {
  it('renders cost as ABSENT with a reason, never as a number with a hedge word', () => {
    const html = render();
    expect(html).toContain('Cost / task');
    expect(html).toContain('not recorded');
    expect(html).not.toContain('notional');
  });

  it('offers median input tokens per task as the de-emphasised stand-in', () => {
    const html = render();
    expect(html).toContain('data-testid="usage-cost-proxy-note"');
    expect(html).toContain('input tokens / task');
  });

  it('drops the proxy entirely once cost is actually measured', () => {
    const html = render({ rows: rows(8).map(r => ({ ...r, costUsd: '0.42' })) });
    expect(html).not.toContain('data-testid="usage-cost-proxy-note"');
    expect(html).toContain('$0.420');
  });
});

describe('UsageClient — code navigation vs shell', () => {
  it('keeps Bash out of code navigation and gives it its own panel', () => {
    const html = render();
    const nav = html.slice(
      html.indexOf('data-testid="usage-section-code-nav"'),
      html.indexOf('data-testid="usage-section-shell"'),
    );
    expect(nav).toContain('Read');
    expect(nav).toContain('Grep');
    expect(nav).not.toContain('Bash');
    expect(html).toContain('Shell (all uses)');
  });

  it('states the shell against tasks with an exact histogram, not against every task', () => {
    // Six exact-histogram tasks + two reconstructed ones, which can never carry
    // a shell call — so they are outside the shell denominator.
    const derived = Array.from({ length: 2 }, (_, i) =>
      worker({
        workerId: `d${i}`,
        taskId: `d-${i}`,
        resultMeta: { cbm: { readCount: 5, grepCount: 1, globCount: 0, toolCalls: {}, totalCbmCalls: 0 } } as any,
      }),
    );
    const html = render({ rows: [...rows(6), ...derived] });
    expect(html).toContain('over 8 tasks (7d)');
    expect(html).toContain('over 6 tasks with an exact histogram');
    expect(html).toContain('Stated over 6 of 8 tasks');
  });

  it('shows no shell delta, and says why', () => {
    const html = render({
      previous: { stats: computeUsageStats(rows(8), 'none'), truncated: false },
    });
    const shell = html.slice(html.indexOf('data-testid="usage-section-shell"'));
    expect(shell).toContain('data-testid="usage-shell-no-delta"');
    expect(shell).not.toContain('vs prev');
  });

  it('shows code-navigation deltas against the previous period', () => {
    const html = render({
      rows: rows(8, { Read: 20 }),
      previous: { stats: computeUsageStats(rows(8, { Read: 10 }), 'none'), truncated: false },
    });
    expect(html).toContain('vs prev');
    expect(html).toContain('+100%');
    expect(html).not.toContain('data-testid="usage-code-nav-delta-withheld"');
  });

  it('withholds code-navigation deltas when the comparison period is a floor', () => {
    const html = render({
      previous: { stats: computeUsageStats(rows(8), 'none'), truncated: true },
    });
    expect(html).toContain('data-testid="usage-code-nav-delta-withheld"');
    expect(html).toContain('scan cap');
  });

  it('marks reconstructed coverage as a floor with ≥', () => {
    const derived = worker({
      workerId: 'd',
      taskId: 'd-1',
      resultMeta: { cbm: { readCount: 5, grepCount: 1, globCount: 0, toolCalls: {}, totalCbmCalls: 0 } } as any,
    });
    const html = render({ rows: [...rows(3), derived] });
    expect(html).toContain('≥3/4 tasks measured exactly');
  });
});

describe('UsageClient — index adoption', () => {
  it('labels the line in sessions and never in tasks', () => {
    const html = render();
    expect(html).toContain('Graph queried in 8 of 16 sessions where it was available (7d, completed sessions only)');
    expect(html).toContain('Index adoption — 50% — 8/16 CBM-enabled sessions');
  });

  it('declares itself session-keyed on an otherwise task-keyed page', () => {
    const html = render();
    expect(html).toContain('data-testid="usage-adoption-session-keyed"');
    expect(html).toContain('Session-keyed');
  });

  it('states the exclusions without requiring a hover', () => {
    const html = render();
    expect(html).toContain('data-testid="usage-adoption-caveat"');
    expect(html).toContain('Failed workers are excluded from both sides');
    expect(html).toContain('rather than counting as zero');
  });

  it('renders an em-dash with a reason when no session had the graph available', () => {
    const html = render({ cbm: null });
    expect(html).toContain('data-testid="usage-adoption-unavailable"');
    expect(html).not.toContain('0% — ');
  });
});

describe('UsageClient — buildd action breakdown', () => {
  it('renders per-action counts, most frequent first', () => {
    const html = render();
    expect(html).toContain('data-testid="usage-section-actions"');
    expect(html).toContain('update_progress');
    expect(html).toContain('claim_task');
    expect(html.indexOf('update_progress')).toBeLessThan(html.indexOf('claim_task'));
  });

  it('no longer claims the data is impossible', () => {
    // This page used to assert "which action ran was never captured. There is
    // nothing to approximate it with." That became false when the runner began
    // writing worker_action_events, and the old copy was actively stopping
    // readers from looking.
    const html = render();
    expect(html).not.toContain('which action ran was never captured');
    expect(html).not.toContain('There is nothing to approximate it with');
    expect(html).not.toContain('data-testid="usage-no-action-decomposition"');
  });

  it('states the coverage denominator, not just the counts', () => {
    expect(render()).toContain('2/4 workers recorded');
  });

  it('warns when the window opens before capture began', () => {
    // No backfill exists, so a pre-capture window cannot tell "quiet" from
    // "not yet recorded" — and a 30d window still opens before that date.
    const html = render({
      actions: actionPanel({ windowStart: new Date('2026-08-01T00:00:00Z') }),
    });
    expect(html).toContain('not yet recorded');
  });

  it('does not warn once the window is entirely inside the captured period', () => {
    expect(render()).not.toContain('not yet recorded');
  });

  it('warns on a pre-capture window even when no events came back', () => {
    // The caveat is a property of the window, not of the result set. An empty
    // pre-capture window is exactly the case that must not read as zero.
    const html = render({
      actions: actionPanel({ rows: [], windowStart: new Date('2026-08-01T00:00:00Z') }),
    });
    expect(html).toContain('No actions recorded in this window');
    expect(html).toContain('not yet recorded');
  });

  it('renders nothing at all when the event stream could not be read', () => {
    // Absence is not zero: the panel disappears rather than showing 0 actions.
    const html = render({ actions: null });
    expect(html).not.toContain('data-testid="usage-section-actions"');
  });

  it('says counts are floors when the row cap was hit', () => {
    const many = Array.from({ length: 20 }, () => ({ workerId: 'w1', action: 'claim_task' }));
    const html = render({ actions: actionPanel({ rows: many, rowLimit: 20 }) });
    expect(html).toContain('counts are floors');
  });

  it('still declines to invent the runtime/work split', () => {
    // That classification is task-conditional and its contract is not settled
    // here; a guessed taxonomy would compete with the real one.
    expect(render()).toContain('No runtime/work split');
  });
});
