import { describe, it, expect } from 'bun:test';
import { sliceByPrecedence, splitTime, TIME_CATEGORIES, type TimeInterval } from './insights-time-split';
import { buildFlowSeries, type FlowInput, type FlowWorkerRow } from './insights-flow';

const H = 3_600_000;
const T0 = Date.UTC(2026, 0, 10, 0, 0, 0);

/** Length of the union of the intervals: the most time they can account for. */
function unionMs(intervals: TimeInterval[]): number {
  const s = intervals.filter(i => i.to > i.from).map(i => [i.from, i.to] as const).sort((a, b) => a[0] - b[0]);
  let total = 0;
  let cur: [number, number] | null = null;
  for (const [a, b] of s) {
    if (!cur || a > cur[1]) { if (cur) total += cur[1] - cur[0]; cur = [a, b]; } else cur[1] = Math.max(cur[1], b);
  }
  return total + (cur ? cur[1] - cur[0] : 0);
}
const sum = (r: Record<string, number>) => Object.values(r).reduce((a, b) => a + b, 0);

describe('sliceByPrecedence', () => {
  it('returns disjoint slices covering exactly the union', () => {
    const intervals: TimeInterval[] = [
      { from: 0, to: 10 * H, category: 'review' },
      { from: 2 * H, to: 4 * H, category: 'running' },
      { from: 3 * H, to: 6 * H, category: 'ci' },
      { from: 12 * H, to: 13 * H, category: 'release' },
    ];
    const slices = sliceByPrecedence(intervals);
    for (let i = 1; i < slices.length; i++) expect(slices[i].from).toBeGreaterThanOrEqual(slices[i - 1].to);
    expect(slices.reduce((m, s) => m + s.to - s.from, 0)).toBe(unionMs(intervals));
  });

  it('an agent working wins over anything it overlaps, then needs input, runner, CI, review, release', () => {
    const slices = sliceByPrecedence([
      { from: 0, to: 6 * H, category: 'release' },
      { from: 0, to: 5 * H, category: 'review' },
      { from: 0, to: 4 * H, category: 'ci' },
      { from: 0, to: 3 * H, category: 'runner' },
      { from: 0, to: 2 * H, category: 'needs_input' },
      { from: 0, to: 1 * H, category: 'running' },
    ]);
    expect(slices.map(s => s.category)).toEqual(['running', 'needs_input', 'runner', 'ci', 'review', 'release']);
    expect(slices.every(s => s.to - s.from === H)).toBe(true);
  });

  it('a retry outranks a plain run when both claim the same instant', () => {
    expect(sliceByPrecedence([
      { from: 0, to: 2 * H, category: 'running' },
      { from: H, to: 3 * H, category: 'retry' },
    ]).map(s => [s.category, (s.to - s.from) / H])).toEqual([['running', 1], ['retry', 2]]);
  });
});

describe('splitTime', () => {
  it('sums to the union of the intervals, never more: no instant is counted twice', () => {
    const intervals: TimeInterval[] = [
      { from: 0, to: 8 * H, category: 'review' },
      { from: H, to: 3 * H, category: 'running' },
      { from: 2 * H, to: 5 * H, category: 'ci' },
      { from: 4 * H, to: 9 * H, category: 'needs_input' },
    ];
    const split = splitTime(intervals);
    expect(sum(split)).toBe(unionMs(intervals));
    expect(split).toMatchObject({ running: 2 * H, ci: H, needs_input: 5 * H, review: H });
  });

  it('clips to the window', () => {
    const split = splitTime([{ from: -2 * H, to: 3 * H, category: 'review' }], { from: 0, to: 2 * H });
    expect(split.review).toBe(2 * H);
    expect(sum(split)).toBe(2 * H);
  });

  it('has a key for every category, zero when absent', () => {
    expect(Object.keys(splitTime([])).sort()).toEqual([...TIME_CATEGORIES].sort());
  });
});

function worker(over: Partial<FlowWorkerRow> & { workerId: string; taskId: string }): FlowWorkerRow {
  return {
    parentTaskId: null, taskTitle: `Task ${over.taskId}`, taskStatus: 'completed', roleSlug: 'builder',
    missionId: null, workspaceId: 'ws-a', status: 'completed', startedAt: null, completedAt: null,
    updatedAt: null, prNumber: null, mergedAt: null, prLifecycleStatus: null, prLastCheckedAt: null,
    prSupersededAt: null, prAbandonedAt: null,
    ...over,
  };
}
function input(over: Partial<FlowInput>): FlowInput {
  return {
    window: { from: T0, to: T0 + 24 * H }, bucketMs: H, now: T0 + 24 * H,
    workers: [], releases: [], releaseTasks: [], releaseWorkspaceIds: [],
    ...over,
  };
}
const row = (s: ReturnType<typeof buildFlowSeries>, c: string) => s.time.find(r => r.category === c)!;

describe('buildFlowSeries: where task time went', () => {
  it('queue, run, CI that failed, a CI fix, review and release, summing to the task’s span', () => {
    const s = buildFlowSeries(input({
      workers: [
        // Created at T0, picked up an hour later, ran 2h, opened PR #7.
        worker({ workerId: 'w1', taskId: 't1', taskCreatedAt: T0, startedAt: T0 + H, completedAt: T0 + 3 * H, prNumber: 7, mergedAt: T0 + 10 * H }),
        // CI failed: a fix task was created at +5h, started at +6h, ran 1h.
        worker({ workerId: 'w2', taskId: 'fix', parentTaskId: 't1', taskCreatedAt: T0 + 5 * H, taskRetryKind: 'ci', startedAt: T0 + 6 * H, completedAt: T0 + 7 * H }),
      ],
      releases: [{ id: 'r1', workspaceId: 'ws-a', version: 'v1', state: 'healthy', at: T0 + 12 * H }],
      releaseWorkspaceIds: ['ws-a'],
    }));
    expect(row(s, 'runner').ms).toBe(2 * H); // T0→+1h, and the fix's +5h→+6h
    expect(row(s, 'running').ms).toBe(2 * H);
    expect(row(s, 'ci').ms).toBe(2 * H); // PR open at +3h until CI failed at +5h
    expect(row(s, 'retry').ms).toBe(H);
    expect(row(s, 'review').ms).toBe(3 * H); // +7h→+10h
    expect(row(s, 'release').ms).toBe(2 * H);
    expect(s.time.reduce((m, r) => m + r.ms, 0)).toBe(12 * H);
    expect(s.tasks[0].time).toMatchObject({ runner: 2 * H, ci: 2 * H, retry: H });
    expect(row(s, 'ci').tasks).toBe(1);
  });

  it('a run after a failed attempt is a retry, and the gap before it waits for a runner', () => {
    const s = buildFlowSeries(input({
      workers: [
        worker({ workerId: 'a', taskId: 't', status: 'failed', startedAt: T0, completedAt: T0 + H }),
        worker({ workerId: 'b', taskId: 't', startedAt: T0 + 3 * H, completedAt: T0 + 4 * H }),
      ],
    }));
    expect(row(s, 'running').ms).toBe(H);
    expect(row(s, 'retry').ms).toBe(H);
    expect(row(s, 'runner').ms).toBe(2 * H);
  });

  it('a task waiting on other tasks does not count that wait as waiting for a runner', () => {
    const s = buildFlowSeries(input({
      workers: [worker({ workerId: 'a', taskId: 't', taskCreatedAt: T0, taskHasDependencies: true, startedAt: T0 + 5 * H, completedAt: T0 + 6 * H })],
    }));
    expect(row(s, 'runner').ms).toBe(0);
  });

  it('an agent parked on a question counts as needs input, not running', () => {
    const now = T0 + 24 * H;
    const s = buildFlowSeries(input({
      workers: [worker({ workerId: 'a', taskId: 't', status: 'waiting_input', taskStatus: 'in_progress', startedAt: now - 4 * H, updatedAt: now - 3 * H })],
    }));
    expect(row(s, 'running').ms).toBe(H);
    expect(row(s, 'needs_input').ms).toBe(3 * H);
  });

  it('an open PR whose checks are running is waiting for CI from its last push', () => {
    const now = T0 + 24 * H;
    const s = buildFlowSeries(input({
      workers: [worker({ workerId: 'a', taskId: 't', startedAt: now - 3 * H, completedAt: now - 2 * H, prNumber: 9, prLifecycleStatus: 'ci_running' })],
    }));
    expect(row(s, 'ci').ms).toBe(2 * H);
    expect(row(s, 'review').ms).toBe(0);
  });

  it('per-task time sums to the series total, and the rows come in display order', () => {
    const s = buildFlowSeries(input({
      workers: [
        worker({ workerId: 'a', taskId: 'x', taskCreatedAt: T0, startedAt: T0 + H, completedAt: T0 + 2 * H, prNumber: 1 }),
        worker({ workerId: 'b', taskId: 'y', startedAt: T0 + 2 * H, completedAt: T0 + 5 * H }),
      ],
    }));
    const perTask = s.tasks.reduce((m, t) => m + sum(t.time ?? {}), 0);
    expect(perTask).toBe(s.time.reduce((m, r) => m + r.ms, 0));
    expect(s.time.map(r => r.category)).toEqual([...TIME_CATEGORIES]);
  });
});

describe('buildFlowSeries: shipped and lost per day', () => {
  it('counts each outcome in the day it happened, not cumulatively', () => {
    const D = 24 * H;
    const s = buildFlowSeries(input({
      window: { from: T0, to: T0 + 3 * D }, now: T0 + 3 * D,
      workers: [
        worker({ workerId: 'a', taskId: 'a', startedAt: T0, completedAt: T0 + H, prNumber: 1, mergedAt: T0 + 2 * H }),
        worker({ workerId: 'b', taskId: 'b', startedAt: T0 + D, completedAt: T0 + D + H, prNumber: 2, mergedAt: T0 + D + 2 * H }),
        worker({ workerId: 'c', taskId: 'c', taskStatus: 'failed', status: 'failed', startedAt: T0 + D, completedAt: T0 + D + H }),
      ],
    }));
    expect(s.days.map(d => [d.shipped, d.lost])).toEqual([[1, 0], [1, 1], [0, 0]]);
    expect(s.days[0]).toMatchObject({ start: T0, end: T0 + D });
  });
});
