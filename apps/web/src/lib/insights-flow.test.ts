import { describe, it, expect } from 'bun:test';
import {
  buildFlowSeries,
  bucketMsFor,
  type FlowInput,
  type FlowWorkerRow,
} from './insights-flow';

const H = 3_600_000;
const T0 = Date.UTC(2026, 0, 10, 0, 0, 0);

function worker(over: Partial<FlowWorkerRow> & { workerId: string; taskId: string }): FlowWorkerRow {
  return {
    parentTaskId: null,
    taskTitle: `Task ${over.taskId}`,
    taskStatus: 'completed',
    roleSlug: 'builder',
    missionId: null,
    workspaceId: 'ws-a',
    status: 'completed',
    startedAt: null,
    completedAt: null,
    updatedAt: null,
    prNumber: null,
    mergedAt: null,
    prLifecycleStatus: null,
    prLastCheckedAt: null,
    prSupersededAt: null,
    prAbandonedAt: null,
    ...over,
  };
}

function input(over: Partial<FlowInput>): FlowInput {
  return {
    window: { from: T0, to: T0 + 10 * H },
    bucketMs: H,
    now: T0 + 10 * H,
    workers: [],
    releases: [],
    releaseTasks: [],
    releaseWorkspaceIds: [],
    ...over,
  };
}

describe('bucketMsFor', () => {
  it('uses hourly buckets for 7d and 6-hour buckets for 30d', () => {
    expect(bucketMsFor('7d')).toBe(H);
    expect(bucketMsFor('30d')).toBe(6 * H);
  });
});

describe('buildFlowSeries: empty', () => {
  it('returns one bucket per interval with zero counts and a null share', () => {
    const s = buildFlowSeries(input({}));
    expect(s.buckets).toHaveLength(10);
    expect(s.buckets[0]).toMatchObject({ start: T0, end: T0 + H, waiting: 0, review: 0, merged: 0, released: 0, lost: 0 });
    expect(s.buckets.every(b => Object.keys(b.running).length === 0)).toBe(true);
    expect(s.headline).toMatchObject({ shippedShare: null, releases: 0, medianStartToProdMs: null, shippedTasks: 0 });
    expect(s.tasks).toEqual([]);
  });
});

describe('buildFlowSeries: stages', () => {
  it('walks one task through running, review, merged and released', () => {
    const s = buildFlowSeries(input({
      workers: [worker({
        workerId: 'w1', taskId: 't1', startedAt: T0 + 1 * H, completedAt: T0 + 2 * H,
        prNumber: 7, mergedAt: T0 + 4 * H, prLifecycleStatus: 'merged',
      })],
      releases: [{ id: 'r1', workspaceId: 'ws-a', version: 'v1', state: 'healthy', at: T0 + 6 * H }],
      releaseTasks: [{ releaseId: 'r1', taskId: 't1' }],
      releaseWorkspaceIds: ['ws-a'],
    }));
    const b = s.buckets;
    expect(b[1].running).toEqual({ builder: 1 });
    expect(b[2].review).toBe(1);
    expect(b[3].review).toBe(1);
    expect(b[4].merged).toBe(1);
    expect(b[5].merged).toBe(1);
    expect(b[5].released).toBe(0);
    expect(b[6].released).toBe(1);
    expect(b[9].released).toBe(1); // cumulative
    expect(b[6].merged).toBe(0);
    expect(s.releases).toEqual([{ at: T0 + 6 * H, version: 'v1', state: 'healthy' }]);
    expect(s.headline.shippedShare).toBe(1);
    expect(s.headline.shippedTasks).toBe(1);
    expect(s.headline.releases).toBe(1);
    expect(s.headline.medianStartToProdMs).toBe(5 * H);
  });

  it('reports a partial bucket as a time-weighted average, not a 0/1 sample', () => {
    const s = buildFlowSeries(input({
      workers: [worker({ workerId: 'w1', taskId: 't1', startedAt: T0, completedAt: T0 + H / 2, taskStatus: 'completed' })],
    }));
    expect(s.buckets[0].running.builder).toBeCloseTo(0.5, 5);
  });

  it('splits the running band by the task role', () => {
    const s = buildFlowSeries(input({
      workers: [
        worker({ workerId: 'w1', taskId: 't1', roleSlug: 'builder', startedAt: T0, completedAt: T0 + H }),
        worker({ workerId: 'w2', taskId: 't2', roleSlug: 'reviewer', startedAt: T0, completedAt: T0 + H }),
        worker({ workerId: 'w3', taskId: 't3', roleSlug: null, startedAt: T0, completedAt: T0 + H }),
      ],
    }));
    expect(s.buckets[0].running).toEqual({ builder: 1, reviewer: 1, unassigned: 1 });
    expect(s.roles).toEqual(['builder', 'reviewer', 'unassigned']);
  });

  it('marks a worker waiting on a person as waiting from when it parked, until now', () => {
    const s = buildFlowSeries(input({
      workers: [worker({
        workerId: 'w1', taskId: 't1', taskStatus: 'in_progress', status: 'waiting_input',
        startedAt: T0 + 1 * H, completedAt: null, updatedAt: T0 + 3 * H,
      })],
    }));
    expect(s.buckets[1].running.builder).toBe(1);
    expect(s.buckets[2].running.builder).toBe(1);
    expect(s.buckets[3].waiting).toBe(1);
    expect(s.buckets[3].running.builder ?? 0).toBe(0);
    expect(s.buckets[9].waiting).toBe(1);
  });

  it('a live worker runs until now', () => {
    const s = buildFlowSeries(input({
      workers: [worker({ workerId: 'w1', taskId: 't1', taskStatus: 'in_progress', status: 'running', startedAt: T0 + 8 * H, completedAt: null })],
    }));
    expect(s.buckets[8].running.builder).toBe(1);
    expect(s.buckets[9].running.builder).toBe(1);
    expect(s.headline.inFlightHours).toBeCloseTo(2, 5);
  });

  it('running wins over an open PR while a fix attempt runs', () => {
    const s = buildFlowSeries(input({
      workers: [
        worker({ workerId: 'w1', taskId: 't1', startedAt: T0, completedAt: T0 + H, prNumber: 9, prLifecycleStatus: 'ci_failed' }),
        worker({ workerId: 'w2', taskId: 't1-fix', parentTaskId: 't1', startedAt: T0 + 2 * H, completedAt: T0 + 3 * H, prNumber: 9, prLifecycleStatus: 'pr_open' }),
      ],
    }));
    expect(s.buckets[1].review).toBe(1);
    expect(s.buckets[2].running.builder).toBe(1);
    expect(s.buckets[2].review).toBe(0);
    expect(s.buckets[3].review).toBe(1);
    expect(s.tasks).toHaveLength(1);
  });

  it('a merged task in a workspace with no release process is shipped at merge', () => {
    const s = buildFlowSeries(input({
      workers: [worker({ workerId: 'w1', taskId: 't1', startedAt: T0, completedAt: T0 + H, prNumber: 3, mergedAt: T0 + 2 * H, prLifecycleStatus: 'merged' })],
      releaseWorkspaceIds: [],
    }));
    expect(s.buckets[2].merged).toBe(0);
    expect(s.buckets[2].released).toBe(1);
    expect(s.headline.shippedShare).toBe(1);
    expect(s.headline.medianStartToProdMs).toBe(2 * H);
  });
});

describe('buildFlowSeries: lost work', () => {
  it('counts a failed task and a closed-unmerged PR as lost, cumulatively', () => {
    const s = buildFlowSeries(input({
      workers: [
        worker({ workerId: 'w1', taskId: 't1', taskStatus: 'failed', status: 'failed', startedAt: T0, completedAt: T0 + H }),
        worker({ workerId: 'w2', taskId: 't2', startedAt: T0, completedAt: T0 + H, prNumber: 4, prLifecycleStatus: 'closed', prLastCheckedAt: T0 + 3 * H }),
      ],
    }));
    expect(s.buckets[0].lost).toBe(0);
    expect(s.buckets[1].lost).toBe(1);
    expect(s.buckets[2].review).toBe(1);
    expect(s.buckets[3].lost).toBe(2);
    expect(s.buckets[3].review).toBe(0);
    expect(s.headline.lostHours).toBeCloseTo(2, 5);
    expect(s.headline.shippedShare).toBe(0);
  });

  it('a PR superseded by another merged PR is not lost; an abandoned one is, at the abandon time', () => {
    const s = buildFlowSeries(input({
      workers: [
        worker({ workerId: 'w1', taskId: 'sup', startedAt: T0, completedAt: T0 + H, prNumber: 1, prLifecycleStatus: 'closed', prSupersededAt: T0 + 2 * H }),
        worker({ workerId: 'w2', taskId: 'ab', startedAt: T0, completedAt: T0 + H, prNumber: 2, prLifecycleStatus: 'closed', prLastCheckedAt: T0 + 5 * H, prAbandonedAt: T0 + 3 * H }),
      ],
    }));
    expect(s.tasks.find(t => t.key === 'sup')!.lostAt).toBeNull();
    expect(s.tasks.find(t => t.key === 'ab')!.lostAt).toBe(T0 + 3 * H);
    expect(s.buckets[2].review).toBe(1); // only the abandoned one is still in review
    expect(s.headline.otherHours).toBeCloseTo(1, 5);
    expect(s.headline.lostHours).toBeCloseTo(1, 5);
  });

  it('a failed attempt whose retry shipped is not lost', () => {
    const s = buildFlowSeries(input({
      workers: [
        worker({ workerId: 'w1', taskId: 't1', taskStatus: 'completed', startedAt: T0, completedAt: T0 + H, prNumber: 5, mergedAt: T0 + 3 * H, prLifecycleStatus: 'merged' }),
        worker({ workerId: 'w2', taskId: 't1', status: 'failed', startedAt: T0 + H, completedAt: T0 + 2 * H }),
      ],
    }));
    expect(s.buckets[9].lost).toBe(0);
    expect(s.headline.shippedShare).toBe(1);
  });

  it('work that ended without a PR is neither shipped nor lost', () => {
    const s = buildFlowSeries(input({
      workers: [
        worker({ workerId: 'w1', taskId: 'research', roleSlug: 'researcher', startedAt: T0, completedAt: T0 + H }),
        worker({ workerId: 'w2', taskId: 't2', startedAt: T0, completedAt: T0 + 3 * H, prNumber: 1, mergedAt: T0 + 4 * H, prLifecycleStatus: 'merged' }),
      ],
    }));
    expect(s.headline.shippedShare).toBe(1);
    expect(s.headline.otherHours).toBeCloseTo(1, 5);
  });

  it('weights the share by agent-hours, not task count', () => {
    const s = buildFlowSeries(input({
      workers: [
        worker({ workerId: 'w1', taskId: 'ok', startedAt: T0, completedAt: T0 + 3 * H, prNumber: 1, mergedAt: T0 + 4 * H, prLifecycleStatus: 'merged' }),
        worker({ workerId: 'w2', taskId: 'bad', taskStatus: 'failed', status: 'failed', startedAt: T0, completedAt: T0 + H }),
      ],
    }));
    expect(s.headline.shippedShare).toBeCloseTo(0.75, 5);
  });
});

describe('buildFlowSeries: retries and releases', () => {
  it('folds retry attempts into their parent task', () => {
    const s = buildFlowSeries(input({
      workers: [
        worker({ workerId: 'w1', taskId: 'p', taskTitle: 'Parent', startedAt: T0, completedAt: T0 + H }),
        worker({ workerId: 'w2', taskId: 'p-retry', parentTaskId: 'p', taskTitle: '[builder · after CI #1] Parent', startedAt: T0 + H, completedAt: T0 + 2 * H, prNumber: 2, mergedAt: T0 + 3 * H, prLifecycleStatus: 'merged' }),
      ],
    }));
    expect(s.tasks).toHaveLength(1);
    expect(s.tasks[0]).toMatchObject({ key: 'p', title: 'Parent' });
    expect(s.headline.shippedTasks).toBe(1);
    expect(s.headline.shippedHours).toBeCloseTo(2, 5);
  });

  it('a task carried by two releases ships at the first healthy one', () => {
    const s = buildFlowSeries(input({
      workers: [worker({ workerId: 'w1', taskId: 't1', startedAt: T0, completedAt: T0 + H, prNumber: 1, mergedAt: T0 + 2 * H, prLifecycleStatus: 'merged' })],
      releases: [
        { id: 'r2', workspaceId: 'ws-a', version: 'v2', state: 'healthy', at: T0 + 7 * H },
        { id: 'r1', workspaceId: 'ws-a', version: 'v1', state: 'healthy', at: T0 + 5 * H },
      ],
      releaseTasks: [{ releaseId: 'r1', taskId: 't1' }, { releaseId: 'r2', taskId: 't1' }],
      releaseWorkspaceIds: ['ws-a'],
    }));
    expect(s.tasks[0].shippedAt).toBe(T0 + 5 * H);
    expect(s.buckets[5].released).toBe(1);
    expect(s.buckets[9].released).toBe(1);
    expect(s.headline.releases).toBe(2);
  });

  it('a failed release does not ship its tasks', () => {
    const s = buildFlowSeries(input({
      workers: [worker({ workerId: 'w1', taskId: 't1', startedAt: T0, completedAt: T0 + H, prNumber: 1, mergedAt: T0 + 2 * H, prLifecycleStatus: 'merged' })],
      releases: [{ id: 'r1', workspaceId: 'ws-a', version: 'v1', state: 'failed', at: T0 + 5 * H }],
      releaseTasks: [{ releaseId: 'r1', taskId: 't1' }],
      releaseWorkspaceIds: ['ws-a'],
    }));
    expect(s.tasks[0].shippedAt).toBeNull();
    expect(s.buckets[9].merged).toBe(1);
    expect(s.headline.releases).toBe(0);
    expect(s.releases).toEqual([{ at: T0 + 5 * H, version: 'v1', state: 'failed' }]);
  });

  it('a release attributed to a retry attempt ships the parent', () => {
    const s = buildFlowSeries(input({
      workers: [
        worker({ workerId: 'w1', taskId: 'p', startedAt: T0, completedAt: T0 + H }),
        worker({ workerId: 'w2', taskId: 'p-r', parentTaskId: 'p', startedAt: T0 + H, completedAt: T0 + 2 * H, prNumber: 1, mergedAt: T0 + 3 * H, prLifecycleStatus: 'merged' }),
      ],
      releases: [{ id: 'r1', workspaceId: 'ws-a', version: 'v1', state: 'healthy', at: T0 + 4 * H }],
      releaseTasks: [{ releaseId: 'r1', taskId: 'p-r' }],
      releaseWorkspaceIds: ['ws-a'],
    }));
    expect(s.tasks[0].shippedAt).toBe(T0 + 4 * H);
  });
});

describe('buildFlowSeries: window edges', () => {
  it('shipping before the window does not count as released in it', () => {
    const s = buildFlowSeries(input({
      workers: [worker({ workerId: 'w1', taskId: 't1', startedAt: T0 - 5 * H, completedAt: T0 - 4 * H, prNumber: 1, mergedAt: T0 - 3 * H, prLifecycleStatus: 'merged' })],
    }));
    expect(s.buckets[0].released).toBe(0);
    expect(s.headline.shippedTasks).toBe(0);
    expect(s.tasks).toEqual([]);
  });

  it('review carried in from before the window shows from the first bucket', () => {
    const s = buildFlowSeries(input({
      workers: [worker({ workerId: 'w1', taskId: 't1', startedAt: T0 - 5 * H, completedAt: T0 - 4 * H, prNumber: 1, prLifecycleStatus: 'pr_open' })],
    }));
    expect(s.buckets[0].review).toBe(1);
    expect(s.tasks).toHaveLength(1);
  });

  it('ignores a worker that never started', () => {
    const s = buildFlowSeries(input({ workers: [worker({ workerId: 'w1', taskId: 't1', taskStatus: 'pending', status: 'idle' })] }));
    expect(s.tasks).toEqual([]);
  });

  it('gives each task segments for the client to list tasks in a band', () => {
    const s = buildFlowSeries(input({
      workers: [worker({ workerId: 'w1', taskId: 't1', missionId: 'm1', startedAt: T0 + H, completedAt: T0 + 2 * H, prNumber: 1, prLifecycleStatus: 'pr_open' })],
    }));
    expect(s.tasks[0].missionId).toBe('m1');
    expect(s.tasks[0].segments).toEqual([
      { stage: 'running', role: 'builder', from: T0 + H, to: T0 + 2 * H },
      { stage: 'review', from: T0 + 2 * H, to: T0 + 10 * H },
    ]);
  });
});

describe('buildFlowSeries: shipping without a release edge', () => {
  const merged = (over: Partial<FlowWorkerRow> = {}) => worker({
    workerId: 'w1', taskId: 't1', startedAt: T0, completedAt: T0 + H,
    prNumber: 1, mergedAt: T0 + 2 * H, prLifecycleStatus: 'merged', prBaseRef: 'dev', ...over,
  });

  it('a merge ships with the first healthy release cut after it, even with no attribution row', () => {
    const s = buildFlowSeries(input({
      workers: [merged()],
      releases: [{ id: 'r1', workspaceId: 'ws-a', version: 'v1', state: 'healthy', at: T0 + 5 * H, cutAt: T0 + 4 * H }],
      releaseWorkspaceIds: ['ws-a'],
    }));
    expect(s.tasks[0].shippedAt).toBe(T0 + 5 * H);
    expect(s.buckets[9].merged).toBe(0);
    expect(s.headline.shippedTasks).toBe(1);
  });

  it('a release cut before the merge does not carry it', () => {
    const s = buildFlowSeries(input({
      workers: [merged()],
      releases: [{ id: 'r1', workspaceId: 'ws-a', version: 'v1', state: 'healthy', at: T0 + 3 * H, cutAt: T0 + 1 * H }],
      releaseWorkspaceIds: ['ws-a'],
    }));
    expect(s.tasks[0].shippedAt).toBeNull();
    expect(s.buckets[9].merged).toBe(1);
  });

  it('skips a failed release and ships with the next healthy one', () => {
    const s = buildFlowSeries(input({
      workers: [merged()],
      releases: [
        { id: 'r1', workspaceId: 'ws-a', version: 'v1', state: 'failed', at: T0 + 4 * H, cutAt: T0 + 3 * H },
        { id: 'r2', workspaceId: 'ws-a', version: 'v2', state: 'degraded', at: T0 + 7 * H, cutAt: T0 + 6 * H },
      ],
      releaseWorkspaceIds: ['ws-a'],
    }));
    expect(s.tasks[0].shippedAt).toBe(T0 + 7 * H);
  });

  it("another workspace's release does not ship it", () => {
    const s = buildFlowSeries(input({
      workers: [merged()],
      releases: [{ id: 'r1', workspaceId: 'ws-b', version: 'v1', state: 'healthy', at: T0 + 5 * H, cutAt: T0 + 4 * H }],
      releaseWorkspaceIds: ['ws-a', 'ws-b'],
    }));
    expect(s.tasks[0].shippedAt).toBeNull();
  });

  it('an attribution row wins when it is earlier', () => {
    const s = buildFlowSeries(input({
      workers: [merged()],
      releases: [
        { id: 'r1', workspaceId: 'ws-a', version: 'v1', state: 'healthy', at: T0 + 3 * H, cutAt: T0 + 1 * H },
        { id: 'r2', workspaceId: 'ws-a', version: 'v2', state: 'healthy', at: T0 + 6 * H, cutAt: T0 + 5 * H },
      ],
      releaseTasks: [{ releaseId: 'r1', taskId: 't1' }],
      releaseWorkspaceIds: ['ws-a'],
    }));
    expect(s.tasks[0].shippedAt).toBe(T0 + 3 * H);
  });

  it('a mission-branch merge ships with the first release after the mission reached trunk', () => {
    const s = buildFlowSeries(input({
      workers: [merged({ prBaseRef: 'mission/x', missionId: 'm1' })],
      releases: [
        { id: 'r1', workspaceId: 'ws-a', version: 'v1', state: 'healthy', at: T0 + 4 * H, cutAt: T0 + 3 * H },
        { id: 'r2', workspaceId: 'ws-a', version: 'v2', state: 'healthy', at: T0 + 8 * H, cutAt: T0 + 7 * H },
      ],
      releaseWorkspaceIds: ['ws-a'],
      missionTrunkMergedAt: { m1: T0 + 6 * H },
    }));
    expect(s.tasks[0].shippedAt).toBe(T0 + 8 * H);
  });

  it("a mission-branch merge whose mission hasn't reached trunk stays merged", () => {
    const s = buildFlowSeries(input({
      workers: [merged({ prBaseRef: 'mission/x', missionId: 'm1' })],
      releases: [{ id: 'r1', workspaceId: 'ws-a', version: 'v1', state: 'healthy', at: T0 + 4 * H, cutAt: T0 + 3 * H }],
      releaseWorkspaceIds: ['ws-a'],
    }));
    expect(s.tasks[0].shippedAt).toBeNull();
    expect(s.buckets[9].merged).toBe(1);
  });
});

describe('buildFlowSeries: agent time of workers that never recorded an end', () => {
  it("caps a finished worker with no end time instead of running it until its row's last update", () => {
    const s = buildFlowSeries(input({
      window: { from: T0, to: T0 + 400 * H },
      now: T0 + 400 * H,
      workers: [worker({ workerId: 'w1', taskId: 't1', status: 'failed', taskStatus: 'completed', startedAt: T0, completedAt: null, updatedAt: T0 + 300 * H })],
    }));
    expect(s.tasks[0].agentHours).toBeLessThanOrEqual(8);
    expect(s.headline.inFlightHours + s.headline.otherHours).toBeLessThanOrEqual(8);
  });

  it('keeps a short unended run at its real length', () => {
    const s = buildFlowSeries(input({
      workers: [worker({ workerId: 'w1', taskId: 't1', status: 'failed', taskStatus: 'completed', startedAt: T0, completedAt: null, updatedAt: T0 + 2 * H })],
    }));
    expect(s.tasks[0].agentHours).toBeCloseTo(2, 5);
  });

  it('counts each worker once even when two rows share a task', () => {
    const s = buildFlowSeries(input({
      workers: [
        worker({ workerId: 'w1', taskId: 't1', startedAt: T0, completedAt: T0 + H }),
        worker({ workerId: 'w1', taskId: 't1', startedAt: T0, completedAt: T0 + H }),
      ],
    }));
    expect(s.tasks[0].agentHours).toBeCloseTo(1, 5);
  });
});
