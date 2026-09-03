import { describe, it, expect } from 'bun:test';
import { computeUsageStats, type UsageWorkerRow } from './usage-stats';
import type { CbmHealthSummary } from './cbm-insight';
import {
  buildCodeNavigationPanel,
  buildShellPanel,
  buildUsageDrilldownView,
  CLAMP_NOTICE,
  costProxyTokens,
  formatDelta,
  healthHref,
  indexAdoptionLine,
  isCodeNavigationTool,
  MIN_DELTA_TASKS,
  resolveDrilldownWindow,
  usageDrilldownHref,
} from './usage-drilldown';

/** A worker with an EXACT tool histogram. */
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
    inputTokens: 100_000,
    outputTokens: 4_000,
    costUsd: null,
    turns: 12,
    resultMeta: { toolCounts: counts ?? { Read: 10, Bash: 4 } } as any,
    mcpCalls: null,
    ...rest,
  };
};

/** A pre-histogram worker: counts reconstructed from CBM counters, never Bash. */
const derivedWorker = (over: Partial<UsageWorkerRow> = {}): UsageWorkerRow =>
  worker({
    resultMeta: { cbm: { readCount: 6, grepCount: 2, globCount: 0, toolCalls: {}, totalCbmCalls: 0 } } as any,
    ...over,
  });

const statsOf = (rows: UsageWorkerRow[]) => computeUsageStats(rows, 'none');

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

describe('resolveDrilldownWindow', () => {
  it('clamps a 24h header window to 7d and says so', () => {
    const r = resolveDrilldownWindow('24h');
    expect(r.window).toBe('7d');
    expect(r.clamped).toBe(true);
    expect(r.notice).toBe(CLAMP_NOTICE);
  });

  it('keeps 24h as the REQUESTED window so back-navigation restores it unclamped', () => {
    expect(resolveDrilldownWindow('24h').requested).toBe('24h');
    expect(healthHref({ window: resolveDrilldownWindow('24h').requested })).toBe('/app/health?window=24h');
  });

  it('inherits 7d and 30d unchanged, with no notice', () => {
    for (const w of ['7d', '30d'] as const) {
      const r = resolveDrilldownWindow(w);
      expect(r.window).toBe(w);
      expect(r.clamped).toBe(false);
      expect(r.notice).toBeNull();
    }
  });

  it('falls back to 7d WITHOUT a clamp notice when nothing was asked for', () => {
    for (const raw of [null, undefined, '', 'banana', '90d']) {
      const r = resolveDrilldownWindow(raw);
      expect(r.window).toBe('7d');
      expect(r.clamped).toBe(false);
      expect(r.notice).toBeNull();
    }
  });
});

describe('links', () => {
  it('carries the header window verbatim into the drill-down, so the clamp is this route’s call', () => {
    expect(usageDrilldownHref({ window: '24h', workspaceId: 'ws-1' }))
      .toBe('/app/health/usage?window=24h&workspace=ws-1');
  });

  it('omits absent params rather than writing empty ones', () => {
    expect(usageDrilldownHref({})).toBe('/app/health/usage');
    expect(healthHref({ window: null, workspaceId: null })).toBe('/app/health');
  });
});

describe('isCodeNavigationTool', () => {
  it('covers Read, Grep, Glob and every codebase-graph tool', () => {
    for (const name of ['Read', 'Grep', 'Glob', 'mcp__codebase-memory__search_graph', 'mcp__codebase-memory__trace_path']) {
      expect(isCodeNavigationTool(name)).toBe(true);
    }
  });

  it('excludes Bash — nothing records the command inside it', () => {
    expect(isCodeNavigationTool('Bash')).toBe(false);
  });

  it('excludes tools that are not navigation at all', () => {
    for (const name of ['Edit', 'Write', 'Task', 'mcp__buildd__buildd', '__other__']) {
      expect(isCodeNavigationTool(name)).toBe(false);
    }
  });
});

describe('buildCodeNavigationPanel', () => {
  const current = statsOf([
    worker({ workerId: 'a', taskId: 't-1', counts: { Read: 10, Grep: 4, Bash: 20 } }),
    worker({ workerId: 'b', taskId: 't-2', counts: { Read: 6, 'mcp__codebase-memory__search_graph': 2, Bash: 5 } }),
  ]);

  it('states per-task rates over TASKS, folding a retried task’s attempts into one', () => {
    // Two workers, one task: the fold is what makes the page task-keyed.
    const folded = statsOf([
      worker({ workerId: 'a', taskId: 't-1', counts: { Read: 10 } }),
      worker({ workerId: 'b', taskId: 't-1', counts: { Read: 6 } }),
    ]);
    const panel = buildCodeNavigationPanel(folded, null, '7d');
    expect(panel.tasks).toBe(1);
    expect(panel.rows.find(r => r.name === 'Read')!.callsPerTask).toBe(16);
  });

  it('leaves Bash out entirely', () => {
    const panel = buildCodeNavigationPanel(current, null, '7d');
    expect(panel.rows.map(r => r.name)).not.toContain('Bash');
    expect(panel.rows.map(r => r.name).sort()).toEqual(['Grep', 'Read', 'mcp__codebase-memory__search_graph']);
  });

  it('takes the delta on calls per task, not on raw calls', () => {
    // Previous period: half the tasks, same per-task rate — a raw-count delta
    // would report -50%; the honest reading is no change.
    const previous = statsOf([worker({ workerId: 'p', taskId: 'p-1', counts: { Read: 8 } })]);
    const busier = statsOf([
      ...Array.from({ length: 6 }, (_, i) =>
        worker({ workerId: `c${i}`, taskId: `c-${i}`, counts: { Read: 8 } }),
      ),
    ]);
    const prevPeriod = statsOf(
      Array.from({ length: 6 }, (_, i) => worker({ workerId: `q${i}`, taskId: `q-${i}`, counts: { Read: 8 } })),
    );
    expect(previous.totals.tasks).toBe(1);
    const panel = buildCodeNavigationPanel(busier, { stats: prevPeriod, truncated: false }, '7d');
    expect(panel.rows.find(r => r.name === 'Read')!.deltaPct).toBe(0);
  });

  it('reports a real per-task rise', () => {
    const prev = statsOf(
      Array.from({ length: 6 }, (_, i) => worker({ workerId: `q${i}`, taskId: `q-${i}`, counts: { Read: 10 } })),
    );
    const now = statsOf(
      Array.from({ length: 6 }, (_, i) => worker({ workerId: `c${i}`, taskId: `c-${i}`, counts: { Read: 15 } })),
    );
    const panel = buildCodeNavigationPanel(now, { stats: prev, truncated: false }, '7d');
    expect(panel.rows.find(r => r.name === 'Read')!.deltaPct).toBeCloseTo(0.5, 6);
  });

  it('withholds deltas when the previous period was truncated by the scan cap', () => {
    const prev = statsOf(
      Array.from({ length: 6 }, (_, i) => worker({ workerId: `q${i}`, taskId: `q-${i}`, counts: { Read: 10 } })),
    );
    const panel = buildCodeNavigationPanel(current, { stats: prev, truncated: true }, '30d');
    expect(panel.deltaWithheld).toContain('scan cap');
    expect(panel.rows.every(r => r.deltaPct === null)).toBe(true);
  });

  it('withholds deltas when the previous period is too small to compare', () => {
    const prev = statsOf(
      Array.from({ length: MIN_DELTA_TASKS - 1 }, (_, i) =>
        worker({ workerId: `q${i}`, taskId: `q-${i}`, counts: { Read: 10 } }),
      ),
    );
    const panel = buildCodeNavigationPanel(current, { stats: prev, truncated: false }, '7d');
    expect(panel.deltaWithheld).toContain('too few to compare');
  });

  it('marks a floor with ≥ inputs when any counted task was reconstructed', () => {
    const mixed = statsOf([
      worker({ workerId: 'a', taskId: 't-1', counts: { Read: 4 } }),
      derivedWorker({ workerId: 'b', taskId: 't-2' }),
    ]);
    const panel = buildCodeNavigationPanel(mixed, null, '7d');
    expect(panel.coverage).toEqual({ covered: 1, population: 2, hasDerived: true });
  });
});

describe('buildShellPanel', () => {
  const stats = statsOf([
    worker({ workerId: 'a', taskId: 't-1', counts: { Bash: 20, Read: 3 } }),
    worker({ workerId: 'b', taskId: 't-2', counts: { Bash: 10 } }),
    derivedWorker({ workerId: 'c', taskId: 't-3' }),
  ]);

  it('states Bash against the tasks with an exact histogram, not against every task', () => {
    const panel = buildShellPanel(stats);
    expect(panel.allTasks).toBe(3);
    // The reconstructed task can never contribute a Bash call, so it is not in
    // the denominator either.
    expect(panel.histogramTasks).toBe(2);
    expect(panel.calls).toBe(30);
    expect(panel.callsPerTask).toBe(15);
  });

  it('offers no delta field at all — not a null one', () => {
    expect('deltaPct' in buildShellPanel(stats)).toBe(false);
  });

  it('reports absence rather than a zero when nothing ran a shell command', () => {
    const panel = buildShellPanel(statsOf([worker({ counts: { Read: 3 } })]));
    expect(panel.present).toBe(false);
    expect(panel.calls).toBe(0);
  });
});

describe('indexAdoptionLine', () => {
  it('counts sessions and never says "task"', () => {
    const line = indexAdoptionLine(cbm(), '7d');
    expect(line.n).toBe(8);
    expect(line.sessions).toBe(16);
    expect(line.label).toBe(
      'Graph queried in 8 of 16 sessions where it was available (7d, completed sessions only)',
    );
    expect(line.shortLabel).toBe('Index adoption — 50% — 8/16 CBM-enabled sessions');
    expect(line.label.toLowerCase()).not.toContain('task');
    expect(line.shortLabel.toLowerCase()).not.toContain('task');
  });

  it('renders an unavailable state with a reason, never 0%', () => {
    for (const summary of [null, cbm({ activeCount: 0, adoptionRate: null, zeroCallTasks: 0 })]) {
      const line = indexAdoptionLine(summary, '30d');
      expect(line.available).toBe(false);
      expect(line.rate).toBeNull();
      expect(line.unavailableReason).toBeTruthy();
      expect(line.shortLabel).not.toContain('0%');
    }
  });
});

describe('cost', () => {
  it('has no proxy to offer when no task recorded tokens either', () => {
    const stats = statsOf([worker({ inputTokens: 0, outputTokens: 0, turns: 0, counts: { Read: 1 } })]);
    expect(stats.perTask.costUsd.kind).toBe('unavailable');
    expect(costProxyTokens(stats.perTask.inputTokens)).toBeNull();
  });

  it('offers median input tokens per task as the stand-in when cost is absent', () => {
    const stats = statsOf([
      worker({ workerId: 'a', taskId: 't-1', inputTokens: 100_000 }),
      worker({ workerId: 'b', taskId: 't-2', inputTokens: 300_000 }),
    ]);
    // Seat auth: cost is ABSENT with a reason, not a zero.
    expect(stats.perTask.costUsd.kind).toBe('unavailable');
    // Nearest-rank p50 over two tasks is the lower of the two.
    expect(costProxyTokens(stats.perTask.inputTokens)).toBe(100_000);
  });
});

describe('formatDelta', () => {
  const row = (over: Record<string, number | null>) => ({
    name: 'Read',
    calls: 10,
    tasks: 2,
    callsPerTask: 5,
    previousPerTask: 4,
    deltaPct: 0.25,
    ...over,
  }) as any;

  it('signs the number', () => {
    expect(formatDelta(row({}), false)).toBe('+25%');
    expect(formatDelta(row({ deltaPct: -0.4 }), false)).toBe('-40%');
  });

  it('says "new" rather than an infinite rise', () => {
    expect(formatDelta(row({ previousPerTask: 0, deltaPct: null }), false)).toBe('new');
  });

  it('renders an em-dash when deltas are withheld', () => {
    expect(formatDelta(row({}), true)).toBe('—');
  });
});

describe('buildUsageDrilldownView', () => {
  it('is task-keyed everywhere except the adoption line, which declares itself', () => {
    const current = statsOf([
      worker({ workerId: 'a', taskId: 't-1', counts: { Read: 10, Bash: 3 } }),
      worker({ workerId: 'b', taskId: 't-1', counts: { Read: 5 } }),
      worker({ workerId: 'c', taskId: 't-2', counts: { Read: 2, Bash: 1 } }),
    ]);
    const view = buildUsageDrilldownView({
      resolution: resolveDrilldownWindow('24h'),
      current,
      previous: null,
      scan: { rows: 3, limit: 5000, truncated: false, completeSince: '2026-08-27T00:00:00.000Z' },
      cbm: cbm(),
    });

    expect(view.window).toBe('7d');
    expect(view.clampNotice).toBe(CLAMP_NOTICE);
    // Three workers, two tasks.
    expect(view.tasks).toBe(2);
    expect(view.totals.workers).toBe(3);
    // The adoption line keeps its own, larger population.
    expect(view.adoption.sessions).toBe(16);
  });
});
