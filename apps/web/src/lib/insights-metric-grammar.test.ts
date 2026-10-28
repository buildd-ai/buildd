import { describe, it, expect } from 'bun:test';
import { buildFlowSeries, type FlowInput, type FlowWorkerRow } from './insights-flow';

const H = 3_600_000;
const D = 24 * H;
// Injected clock: never Date.now(). Oct 17 2026 14:00 UTC.
const NOW = Date.UTC(2026, 9, 17, 14);

function worker(over: Partial<FlowWorkerRow> & { workerId: string; taskId: string }): FlowWorkerRow {
  return {
    parentTaskId: null, taskTitle: `Task ${over.taskId}`, taskStatus: 'completed', roleSlug: 'builder', missionId: null,
    workspaceId: 'ws', status: 'completed', startedAt: null, completedAt: null, updatedAt: null, prNumber: null,
    mergedAt: null, prLifecycleStatus: null, prLastCheckedAt: null, prSupersededAt: null, prAbandonedAt: null, ...over,
  };
}
const shipped = (id: string, at: number, startedAt = at - 2 * H): FlowWorkerRow =>
  worker({ workerId: id, taskId: id, startedAt, completedAt: at - H, prNumber: 1, mergedAt: at });
const failed = (id: string, at: number): FlowWorkerRow =>
  worker({ workerId: id, taskId: id, taskStatus: 'failed', status: 'failed', startedAt: at - H, completedAt: at });

function series(workers: FlowWorkerRow[], now = NOW, span = 7 * D, over: Partial<FlowInput> = {}) {
  return buildFlowSeries({ window: { from: now - span, to: now }, bucketMs: H, now, workers, releases: [], releaseTasks: [], releaseWorkspaceIds: [], ...over });
}

describe('window boundaries', () => {
  it('counts a ship at the window start, and not one at the end or before the start', () => {
    const s = series([shipped('at-start', NOW - 7 * D), shipped('before', NOW - 7 * D - 1), shipped('at-end', NOW), shipped('inside', NOW - 1)]);
    expect(s.headline.shippedTasks).toBe(2);
    expect(s.days.reduce((n, d) => n + d.shipped, 0)).toBe(2);
  });

  it('puts every ship in exactly one window: the span before ends where this one starts', () => {
    const from = NOW - 7 * D;
    const rows = [shipped('a', from), shipped('b', from - 1), shipped('c', from - 7 * D)];
    const current = series(rows);
    const prior = buildFlowSeries({ window: { from: from - 7 * D, to: from }, bucketMs: 7 * D, now: NOW, workers: rows, releases: [], releaseTasks: [], releaseWorkspaceIds: [] });
    expect(current.headline.shippedTasks).toBe(1);
    expect(prior.headline.shippedTasks).toBe(2);
  });

  it('day slices tile the window and their totals equal the headline', () => {
    const s = series([shipped('a', NOW - 3 * D), shipped('b', NOW - 3 * D + H), shipped('c', NOW - 5), failed('f', NOW - 2 * D)]);
    expect(s.days[0].start).toBe(NOW - 7 * D);
    expect(s.days.at(-1)!.end).toBe(NOW);
    s.days.slice(1).forEach((d, i) => expect(d.start).toBe(s.days[i].end));
    expect(s.days.reduce((n, d) => n + d.shipped, 0)).toBe(s.headline.shippedTasks);
    expect(s.days.reduce((n, d) => n + d.lost, 0)).toBe(s.headline.lostTasks);
  });

  it('the same data a minute apart moves only the edge, by the injected clock', () => {
    const rows = [shipped('a', NOW - 7 * D + 60_000)];
    expect(series(rows).headline.shippedTasks).toBe(1);
    expect(series(rows, NOW + 120_000).headline.shippedTasks).toBe(0);
  });
});

describe('midnight and DST', () => {
  it('slices by 24 elapsed hours, so a clock change cannot make a 23- or 25-hour bar', () => {
    // US clocks went back on 2026-11-01; a window spanning it still has 7 equal slices.
    const now = Date.UTC(2026, 10, 3, 5);
    const s = series([], now);
    expect(s.days).toHaveLength(7);
    expect(s.days.every(d => d.end - d.start === D)).toBe(true);
  });

  it('a ship a millisecond either side of UTC midnight lands in adjacent slices of a midnight-aligned window', () => {
    const midnight = Date.UTC(2026, 9, 17);
    const now = midnight + D;
    const s = series([shipped('a', midnight - 1), shipped('b', midnight)], now, 2 * D);
    expect(s.days.map(d => d.shipped)).toEqual([1, 1]);
  });
});

describe('failed or abandoned', () => {
  it('counts only outcomes inside the window, not an old failure whose task still ran in it', () => {
    const old = NOW - 8 * D;
    const s = series([
      worker({ workerId: 'old', taskId: 'old', taskStatus: 'failed', status: 'failed', startedAt: old, completedAt: old + H }),
      failed('new', NOW - D),
    ]);
    expect(s.headline.lostTasks).toBe(1);
  });

  it('a PR closed unmerged, or recorded abandoned, is lost; one superseded by a merged PR is neither shipped nor lost', () => {
    const base = { startedAt: NOW - 3 * D, completedAt: NOW - 3 * D + H, prNumber: 9 };
    const s = series([
      worker({ workerId: 'closed', taskId: 'closed', ...base, prLifecycleStatus: 'closed', prLastCheckedAt: NOW - D }),
      worker({ workerId: 'aband', taskId: 'aband', ...base, prLifecycleStatus: 'closed', prAbandonedAt: NOW - 2 * D }),
      worker({ workerId: 'super', taskId: 'super', ...base, prLifecycleStatus: 'closed', prSupersededAt: NOW - D }),
    ]);
    expect(s.headline.lostTasks).toBe(2);
    expect(s.headline.shippedTasks).toBe(0);
  });

  it('a cancelled task with no PR is lost, a completed one with no PR is not', () => {
    const s = series([
      worker({ workerId: 'c', taskId: 'c', taskStatus: 'cancelled', status: 'failed', startedAt: NOW - D, completedAt: NOW - D + H }),
      worker({ workerId: 'r', taskId: 'r', startedAt: NOW - D, completedAt: NOW - D + H }),
    ]);
    expect(s.headline.lostTasks).toBe(1);
  });
});

describe('start to production', () => {
  it('runs from the first worker start across retries, to the ship, once per task', () => {
    const at = NOW - D;
    const s = series([
      worker({ workerId: 'a1', taskId: 't', status: 'failed', startedAt: at - 10 * H, completedAt: at - 9 * H }),
      worker({ workerId: 'a2', taskId: 't', startedAt: at - 3 * H, completedAt: at - H, prNumber: 4, mergedAt: at }),
    ]);
    expect(s.headline.shippedTasks).toBe(1);
    expect(s.headline.medianStartToProdMs).toBe(10 * H);
  });

  it('counts a task once when it has several PRs, and a retry task under its parent', () => {
    const at = NOW - D;
    const s = series([
      worker({ workerId: 'p', taskId: 'parent', startedAt: at - 6 * H, completedAt: at - 5 * H, prNumber: 1, prLifecycleStatus: 'closed', prLastCheckedAt: at - 4 * H }),
      worker({ workerId: 'c', taskId: 'child', parentTaskId: 'parent', startedAt: at - 3 * H, completedAt: at - H, prNumber: 2, mergedAt: at }),
    ]);
    expect(s.headline.shippedTasks).toBe(1);
    expect(s.headline.lostTasks).toBe(0);
    expect(s.headline.medianStartToProdMs).toBe(6 * H);
  });
});

describe('waiting is per item, not a summed headline', () => {
  it('reports each category as an affected-task count with median and 90th percentile, and keeps the cumulative total', () => {
    const waits = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const rows = waits.map((h, i) => worker({
      workerId: `w${i}`, taskId: `t${i}`, startedAt: NOW - 3 * D + h * H, completedAt: NOW - 3 * D + h * H + H,
      taskCreatedAt: NOW - 3 * D,
    }));
    const runner = series(rows).time.find(r => r.category === 'runner')!;
    expect(runner.tasks).toBe(10);
    expect(runner.ms).toBe(55 * H);
    expect(runner.medianMs).toBe(5.5 * H);
    expect(runner.p90Ms).toBe(9 * H);
    expect(runner.longestMs).toBe(10 * H);
  });
});
