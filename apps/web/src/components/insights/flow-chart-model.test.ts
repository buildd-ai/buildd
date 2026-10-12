import { describe, it, expect } from 'bun:test';
import { buildFlowSeries, type FlowWorkerRow } from '@/lib/insights-flow';
import {
  formatDuration,
  formatHours,
  formatShare,
  roleHours,
  tasksInBand,
} from './flow-chart-model';
import { emptyFlowSeries, resolveInsightsQaState, sampleFlowSeries } from '@/app/app/(protected)/health/insights/sample-series';

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
