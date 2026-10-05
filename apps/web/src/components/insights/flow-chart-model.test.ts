import { describe, it, expect } from 'bun:test';
import { buildFlowSeries, type FlowWorkerRow } from '@/lib/insights-flow';
import {
  STACK,
  bandValue,
  buildGeometry,
  formatDuration,
  formatHours,
  formatShare,
  niceCeil,
  roleHours,
  tasksInBand,
} from './flow-chart-model';
import { dailyRows, fmtCount } from './FlowChart';
import { emptyFlowSeries, resolveInsightsQaState, sampleFlowSeries } from '@/app/app/(protected)/insights/sample-series';

const H = 3_600_000;
const T0 = Date.UTC(2026, 0, 10, 0, 0, 0);

function w(over: Partial<FlowWorkerRow> & { workerId: string; taskId: string }): FlowWorkerRow {
  return {
    parentTaskId: null, taskTitle: over.taskId, taskStatus: 'completed', roleSlug: 'builder', missionId: null,
    workspaceId: 'ws', status: 'completed', startedAt: null, completedAt: null, updatedAt: null,
    prNumber: null, mergedAt: null, prLifecycleStatus: null, prLastCheckedAt: null, prSupersededAt: null, prAbandonedAt: null,
    ...over,
  };
}

function series(workers: FlowWorkerRow[]) {
  return buildFlowSeries({
    window: { from: T0, to: T0 + 24 * H }, bucketMs: H, now: T0 + 24 * H,
    workers, releases: [{ id: 'r', workspaceId: 'ws', version: 'v1', state: 'healthy', at: T0 + 12 * H }],
    releaseTasks: [{ releaseId: 'r', taskId: 'a' }], releaseWorkspaceIds: ['ws'],
  });
}

const S = series([
  w({ workerId: '1', taskId: 'a', startedAt: T0 + H, completedAt: T0 + 3 * H, prNumber: 1, mergedAt: T0 + 5 * H, prLifecycleStatus: 'merged' }),
  w({ workerId: '2', taskId: 'b', roleSlug: 'reviewer', startedAt: T0 + 2 * H, completedAt: T0 + 4 * H }),
  w({ workerId: '3', taskId: 'c', taskStatus: 'failed', status: 'failed', startedAt: T0 + 6 * H, completedAt: T0 + 7 * H }),
]);

describe('niceCeil', () => {
  it('rounds up on a fine ladder so the stack fills most of the height', () => {
    expect(niceCeil(0)).toBe(1);
    expect(niceCeil(1.2)).toBe(1.5);
    expect(niceCeil(3)).toBe(3);
    expect(niceCeil(7)).toBe(8);
    expect(niceCeil(11)).toBe(15);
    expect(niceCeil(101)).toBe(150);
  });
});

describe('buildGeometry', () => {
  const g = buildGeometry(S, 400, 220);

  it('draws every stacked band and lost work below the axis', () => {
    for (const k of STACK) expect(g.paths[k].startsWith('M')).toBe(true);
    expect(g.maxDown).toBe(1);
    expect(g.paths.lost.startsWith('M')).toBe(true);
    expect(g.zeroY).toBeLessThan(g.plot.bottom);
  });

  it('keeps the axis at the bottom when nothing was lost', () => {
    const g2 = buildGeometry(series([w({ workerId: '1', taskId: 'x', startedAt: T0, completedAt: T0 + H })]), 400, 220);
    expect(g2.maxDown).toBe(0);
    expect(g2.paths.lost).toBe('');
    expect(g2.zeroY).toBe(g2.plot.bottom);
  });

  it('gives lost work 15-35% of the height whatever its size, and drops a colliding tick label', () => {
    const many = series(Array.from({ length: 30 }, (_, n) =>
      w({ workerId: `f${n}`, taskId: `f${n}`, taskStatus: 'failed', status: 'failed', startedAt: T0 + n * 600_000, completedAt: T0 + n * 600_000 + 60_000 })));
    const gm = buildGeometry(many, 400, 220);
    const plotH = gm.plot.bottom - gm.plot.top;
    expect((gm.plot.bottom - gm.zeroY) / plotH).toBeCloseTo(0.35, 5);
    const busy = series(Array.from({ length: 40 }, (_, n) =>
      w({ workerId: `r${n}`, taskId: `r${n}`, startedAt: T0, completedAt: T0 + 20 * H })).concat(
      w({ workerId: 'x', taskId: 'x', taskStatus: 'failed', status: 'failed', startedAt: T0, completedAt: T0 + H })));
    const gb = buildGeometry(busy, 400, 220);
    expect((gb.plot.bottom - gb.zeroY) / (gb.plot.bottom - gb.plot.top)).toBeCloseTo(0.15, 5);
    const tiny = buildGeometry(S, 400, 60);
    expect(tiny.yTicks.some(t => t.value < 0)).toBe(false);
  });

  it('places release marks on the time axis', () => {
    expect(g.releases).toHaveLength(1);
    expect(g.releases[0].x).toBeCloseTo(g.plot.left + (g.plot.right - g.plot.left) / 2, 5);
    expect(g.releases[0].shipped).toBe(true);
  });

  it('maps a pointer x back to the bucket under it, clamped', () => {
    expect(g.bucketIndexAt(g.plot.left)).toBe(0);
    expect(g.bucketIndexAt(g.plot.right + 50)).toBe(23);
    expect(g.bucketIndexAt(g.plot.left - 50)).toBe(0);
    expect(g.bucketIndexAt(g.xOf(T0 + 2.5 * H))).toBe(2);
  });

  it('the y scale covers the tallest stack', () => {
    const tallest = Math.max(...S.buckets.map(b => STACK.reduce((s, k) => s + bandValue(b, k), 0)));
    expect(g.maxUp).toBeGreaterThanOrEqual(tallest);
  });
});

describe('tasksInBand', () => {
  it('lists the tasks behind a band at a time', () => {
    expect(tasksInBand(S, 2, 'running').map(t => t.key).sort()).toEqual(['a', 'b']);
    expect(tasksInBand(S, 4, 'review').map(t => t.key)).toEqual(['a']);
    expect(tasksInBand(S, 13, 'released').map(t => t.key)).toEqual(['a']);
    expect(tasksInBand(S, 11, 'released')).toEqual([]);
    expect(tasksInBand(S, 8, 'lost').map(t => t.key)).toEqual(['c']);
    expect(tasksInBand(S, 99, 'running')).toEqual([]);
  });
});

describe('roleHours', () => {
  it('sums agent time by role, largest first', () => {
    expect(roleHours(S)).toEqual([{ role: 'builder', hours: 3 }, { role: 'reviewer', hours: 2 }]);
  });
});

describe('dailyRows', () => {
  it('averages work stages over the day and takes the end-of-day running totals', () => {
    const rows = dailyRows(S);
    const total = rows.reduce((n, r) => n + r.values.running * 24, 0);
    expect(total).toBeCloseTo(5, 5);
    expect(rows[rows.length - 1].values.released).toBe(1);
    expect(rows[rows.length - 1].values.lost).toBe(1);
  });
});

describe('formatting', () => {
  it('formats hours, durations and shares for people', () => {
    expect(formatHours(0.5)).toBe('30m');
    expect(formatHours(2.25)).toBe('2.3h');
    expect(formatHours(14.4)).toBe('14h');
    expect(formatDuration(null)).toBe('—');
    expect(formatDuration(5 * H)).toBe('5.0h');
    expect(formatDuration(72 * H)).toBe('3.0d');
    expect(formatShare(null)).toBe('—');
    expect(formatShare(0.614)).toBe('61%');
  });
});

describe('fmtCount', () => {
  it('keeps whole numbers whole and shows a decimal only below one', () => {
    expect(fmtCount(0)).toBe('0');
    expect(fmtCount(0.3)).toBe('0.3');
    expect(fmtCount(0.97)).toBe('1');
    expect(fmtCount(1)).toBe('1');
    expect(fmtCount(6.4)).toBe('6');
  });
});

describe('empty state', () => {
  it('has buckets but no tasks, releases or share', () => {
    const e = emptyFlowSeries('7d', T0 + 7 * 24 * H);
    expect(e.buckets).toHaveLength(168);
    expect(e.tasks).toEqual([]);
    expect(e.headline.shippedShare).toBeNull();
  });
});

describe('sample state', () => {
  it('is dev-server only', () => {
    expect(resolveInsightsQaState('sample', 'development')).toBe('sample');
    expect(resolveInsightsQaState('sample', 'production')).toBeNull();
    expect(resolveInsightsQaState('other', 'development')).toBeNull();
    expect(resolveInsightsQaState('empty', 'development')).toBe('empty');
    expect(resolveInsightsQaState('not-admin', 'development')).toBe('not-admin');
    expect(resolveInsightsQaState('not-admin', 'production')).toBeNull();
    expect(resolveInsightsQaState(['empty', 'sample'], 'development')).toBe('empty');
  });

  it('renders a populated, deterministic week through the real fold', () => {
    const now = T0 + 7 * 24 * H;
    const a = sampleFlowSeries('7d', now);
    const b = sampleFlowSeries('7d', now);
    expect(a.tasks.length).toBeGreaterThan(10);
    expect(a.releases.length).toBeGreaterThan(2);
    expect(a.headline.shippedShare).not.toBeNull();
    expect(JSON.stringify(a.headline)).toBe(JSON.stringify(b.headline));
  });
});
