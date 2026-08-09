import { describe, it, expect } from 'bun:test';
import { groupTimelineTasks, gateChipCollapsed } from './condensed-timeline';
import type { CondensedTask } from './condensed-timeline';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTask(overrides: Partial<CondensedTask> & { id: string }): CondensedTask {
  return {
    status: 'pending',
    dependsOn: null,
    workers: [],
    ...overrides,
  };
}

function withWorker(
  task: CondensedTask,
  w: Partial<CondensedTask['workers'][0]> & { status: string },
): CondensedTask {
  return {
    ...task,
    workers: [
      {
        id: 'w-' + task.id,
        prUrl: null,
        prNumber: null,
        prLifecycleStatus: null,
        mergedAt: null,
        completedAt: null,
        startedAt: null,
        currentAction: null,
        waitingFor: null,
        ...w,
      },
    ],
  };
}

/** Worker in a terminal (non-live) state — typical for completed/failed tasks. */
function doneWorker(overrides: Partial<CondensedTask['workers'][0]> = {}): { status: string } & Partial<CondensedTask['workers'][0]> {
  return { status: 'completed', ...overrides };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('groupTimelineTasks', () => {
  // ── Running group ───────────────────────────────────────────────────────────

  it('routes a task with a running worker to the running group', () => {
    const task = withWorker(makeTask({ id: 't1' }), { status: 'running' });
    const { running } = groupTimelineTasks([task], new Map([['t1', task]]));
    expect(running.map(t => t.id)).toEqual(['t1']);
  });

  it('routes a task with a starting worker to the running group', () => {
    const task = withWorker(makeTask({ id: 't1' }), { status: 'starting' });
    const { running } = groupTimelineTasks([task], new Map([['t1', task]]));
    expect(running).toHaveLength(1);
  });

  it('routes a waiting_input worker to the running group', () => {
    const task = withWorker(makeTask({ id: 't1', status: 'pending' }), {
      status: 'waiting_input',
      waitingFor: { type: 'prompt', prompt: 'Continue?' },
    });
    const { running } = groupTimelineTasks([task], new Map([['t1', task]]));
    expect(running).toHaveLength(1);
  });

  it('routes a task with an idle worker (just claimed) to the running group', () => {
    const task = withWorker(makeTask({ id: 't1' }), { status: 'idle' });
    const { running } = groupTimelineTasks([task], new Map([['t1', task]]));
    expect(running).toHaveLength(1);
  });

  // ── Waiting-on-you group ─────────────────────────────────────────────────

  it('routes a completed task with an open PR to waitingOnYou', () => {
    const task = withWorker(makeTask({ id: 't1', status: 'completed' }), doneWorker({
      prUrl: 'https://github.com/org/repo/pull/1',
      prNumber: 1,
      prLifecycleStatus: 'open',
      mergedAt: null,
    }));
    const { waitingOnYou } = groupTimelineTasks([task], new Map([['t1', task]]));
    expect(waitingOnYou.map(t => t.id)).toEqual(['t1']);
  });

  it('routes a completed task with null prLifecycleStatus + open PR to waitingOnYou (unknown = open)', () => {
    // null prLifecycleStatus means we haven't heard back from GitHub yet — treat as open
    const task = withWorker(makeTask({ id: 't1', status: 'completed' }), doneWorker({
      prUrl: 'https://github.com/org/repo/pull/2',
      prNumber: 2,
      prLifecycleStatus: null,
      mergedAt: null,
    }));
    const { waitingOnYou } = groupTimelineTasks([task], new Map([['t1', task]]));
    expect(waitingOnYou).toHaveLength(1);
  });

  it('routes a completed task with a closed PR to done (not waitingOnYou)', () => {
    const task = withWorker(makeTask({ id: 't1', status: 'completed' }), doneWorker({
      prUrl: 'https://github.com/org/repo/pull/3',
      prNumber: 3,
      prLifecycleStatus: 'closed',
      mergedAt: null,
    }));
    const groups = groupTimelineTasks([task], new Map([['t1', task]]));
    expect(groups.waitingOnYou).toHaveLength(0);
    expect(groups.done).toHaveLength(1);
  });

  // ── Done group ────────────────────────────────────────────────────────────

  it('routes a completed task with no PR to done', () => {
    const task = withWorker(makeTask({ id: 't1', status: 'completed' }), doneWorker({
      prUrl: null,
      mergedAt: null,
    }));
    const { done } = groupTimelineTasks([task], new Map([['t1', task]]));
    expect(done).toHaveLength(1);
  });

  it('routes a completed task with a merged PR to done', () => {
    const task = withWorker(makeTask({ id: 't1', status: 'completed' }), doneWorker({
      prUrl: 'https://github.com/org/repo/pull/4',
      prNumber: 4,
      prLifecycleStatus: 'merged',
      mergedAt: '2025-01-01T00:00:00Z',
    }));
    const groups = groupTimelineTasks([task], new Map([['t1', task]]));
    expect(groups.done).toHaveLength(1);
    expect(groups.waitingOnYou).toHaveLength(0);
  });

  it('routes a completed task with no workers to done', () => {
    const task = makeTask({ id: 't1', status: 'completed' });
    const { done } = groupTimelineTasks([task], new Map([['t1', task]]));
    expect(done).toHaveLength(1);
  });

  // ── Failed group ──────────────────────────────────────────────────────────

  it('routes a failed task to the failed group', () => {
    const task = makeTask({ id: 't1', status: 'failed' });
    const { failed } = groupTimelineTasks([task], new Map([['t1', task]]));
    expect(failed).toHaveLength(1);
  });

  // ── Next-queued group ─────────────────────────────────────────────────────

  it('routes a pending task with no deps to nextQueued', () => {
    const task = makeTask({ id: 't1', status: 'pending', dependsOn: null });
    const { nextQueued } = groupTimelineTasks([task], new Map([['t1', task]]));
    expect(nextQueued).toHaveLength(1);
  });

  it('routes a pending task with empty dependsOn to nextQueued', () => {
    const task = makeTask({ id: 't1', status: 'pending', dependsOn: [] });
    const { nextQueued } = groupTimelineTasks([task], new Map([['t1', task]]));
    expect(nextQueued).toHaveLength(1);
  });

  it('routes a pending task whose dep is completed + merged to nextQueued', () => {
    const dep = withWorker(makeTask({ id: 'dep1', status: 'completed' }), doneWorker({
      prUrl: 'https://github.com/org/repo/pull/5',
      mergedAt: '2025-01-01T00:00:00Z',
    }));
    const task = makeTask({ id: 't1', status: 'pending', dependsOn: ['dep1'] });
    const taskMap = new Map([
      ['dep1', dep],
      ['t1', task],
    ]);
    const { nextQueued } = groupTimelineTasks([dep, task], taskMap);
    expect(nextQueued.map(t => t.id)).toEqual(['t1']);
  });

  it('routes a pending task whose dep is completed + no PR to nextQueued', () => {
    const dep = withWorker(makeTask({ id: 'dep1', status: 'completed' }), doneWorker({
      prUrl: null,
      mergedAt: null,
    }));
    const task = makeTask({ id: 't1', status: 'pending', dependsOn: ['dep1'] });
    const taskMap = new Map([['dep1', dep], ['t1', task]]);
    const { nextQueued } = groupTimelineTasks([dep, task], taskMap);
    expect(nextQueued.map(t => t.id)).toContain('t1');
  });

  // ── Blocked group ─────────────────────────────────────────────────────────

  it('routes a pending task with an incomplete dep to blocked', () => {
    const dep = makeTask({ id: 'dep1', status: 'pending' });
    const task = makeTask({ id: 't1', status: 'pending', dependsOn: ['dep1'] });
    const taskMap = new Map([['dep1', dep], ['t1', task]]);
    const { blocked, nextQueued } = groupTimelineTasks([dep, task], taskMap);
    expect(blocked.map(t => t.id)).toContain('t1');
    expect(nextQueued.map(t => t.id)).not.toContain('t1');
  });

  it('routes a pending task whose dep is completed with an open PR to blocked', () => {
    const dep = withWorker(makeTask({ id: 'dep1', status: 'completed' }), doneWorker({
      prUrl: 'https://github.com/org/repo/pull/6',
      prNumber: 6,
      prLifecycleStatus: 'open',
      mergedAt: null,
    }));
    const task = makeTask({ id: 't1', status: 'pending', dependsOn: ['dep1'] });
    const taskMap = new Map([['dep1', dep], ['t1', task]]);
    const { blocked } = groupTimelineTasks([dep, task], taskMap);
    expect(blocked.map(t => t.id)).toContain('t1');
  });

  // ── Priority: live worker takes precedence ────────────────────────────────

  it('routes a task with status=completed but a still-running worker to running (live worker wins)', () => {
    // Unusual transitional state — must be handled gracefully without crashing
    const task = withWorker(makeTask({ id: 't1', status: 'completed' }), {
      status: 'running',
      prUrl: 'https://github.com/org/repo/pull/7',
      mergedAt: null,
    });
    const { running, waitingOnYou } = groupTimelineTasks([task], new Map([['t1', task]]));
    expect(running).toHaveLength(1);
    expect(waitingOnYou).toHaveLength(0);
  });

  // ── Multi-task scenarios ──────────────────────────────────────────────────

  it('handles a mix of tasks and assigns each to the correct group', () => {
    const running = withWorker(makeTask({ id: 'running', status: 'pending' }), { status: 'running' });
    const waiting = withWorker(makeTask({ id: 'waiting', status: 'completed' }), doneWorker({
      prUrl: 'https://github.com/org/repo/pull/10',
      prNumber: 10,
      prLifecycleStatus: 'open',
      mergedAt: null,
    }));
    const queued = makeTask({ id: 'queued', status: 'pending' });
    const done = withWorker(makeTask({ id: 'done', status: 'completed' }), doneWorker({
      prUrl: 'https://github.com/org/repo/pull/11',
      prNumber: 11,
      mergedAt: '2025-01-01T00:00:00Z',
    }));
    const failed = makeTask({ id: 'failed', status: 'failed' });

    const tasks = [running, waiting, queued, done, failed];
    const taskMap = new Map(tasks.map(t => [t.id, t]));
    const groups = groupTimelineTasks(tasks, taskMap);

    expect(groups.running.map(t => t.id)).toEqual(['running']);
    expect(groups.waitingOnYou.map(t => t.id)).toEqual(['waiting']);
    expect(groups.nextQueued.map(t => t.id)).toEqual(['queued']);
    expect(groups.done.map(t => t.id)).toEqual(['done']);
    expect(groups.failed.map(t => t.id)).toEqual(['failed']);
  });

  it('returns empty groups when there are no tasks', () => {
    const groups = groupTimelineTasks([], new Map());
    expect(groups.waitingOnYou).toHaveLength(0);
    expect(groups.running).toHaveLength(0);
    expect(groups.nextQueued).toHaveLength(0);
    expect(groups.blocked).toHaveLength(0);
    expect(groups.done).toHaveLength(0);
    expect(groups.failed).toHaveLength(0);
  });

  it('ignores unknown deps in the task map (treats them as gate-satisfied)', () => {
    const task = makeTask({ id: 't1', status: 'pending', dependsOn: ['unknown-dep'] });
    const { nextQueued } = groupTimelineTasks([task], new Map([['t1', task]]));
    expect(nextQueued).toHaveLength(1);
  });
});

// ─── WAITING ON YOU membership rule ──────────────────────────────────────────
//
// Unit test coverage for the 5 cases from the task spec:
//   open+approved  → in  (humanActionPending: true, e.g. reviewer_approved note)
//   open+unreviewed → out (humanActionPending: false, agent-review policy, no verdict yet)
//   merged          → out (prLifecycleStatus: 'merged', even when mergedAt is null)
//   closed          → out (prLifecycleStatus: 'closed')
//   escalated       → in  (humanActionPending: true, e.g. reviewer_escalated note)

describe('groupTimelineTasks — WAITING ON YOU membership rule', () => {
  it('open+approved (humanActionPending: true) → waitingOnYou', () => {
    const task: CondensedTask = {
      id: 't1',
      status: 'completed',
      dependsOn: null,
      humanActionPending: true,
      workers: [{
        id: 'w1', status: 'completed',
        prUrl: 'https://github.com/org/repo/pull/100',
        prNumber: 100,
        prLifecycleStatus: 'ci_green',
        mergedAt: null,
        completedAt: null, startedAt: null, currentAction: null, waitingFor: null, branch: null,
      }],
    };
    const groups = groupTimelineTasks([task], new Map([['t1', task]]));
    expect(groups.waitingOnYou.map(t => t.id)).toContain('t1');
    expect(groups.done).toHaveLength(0);
  });

  it('open+unreviewed (humanActionPending: false) → done, not waitingOnYou', () => {
    const task: CondensedTask = {
      id: 't1',
      status: 'completed',
      dependsOn: null,
      humanActionPending: false,
      workers: [{
        id: 'w1', status: 'completed',
        prUrl: 'https://github.com/org/repo/pull/101',
        prNumber: 101,
        prLifecycleStatus: 'pr_open',
        mergedAt: null,
        completedAt: null, startedAt: null, currentAction: null, waitingFor: null, branch: null,
      }],
    };
    const groups = groupTimelineTasks([task], new Map([['t1', task]]));
    expect(groups.waitingOnYou).toHaveLength(0);
    expect(groups.done.map(t => t.id)).toContain('t1');
  });

  it('merged (prLifecycleStatus=merged, mergedAt=null) → done, not waitingOnYou', () => {
    // Stale DB state: webhook set prLifecycleStatus but mergedAt was missed
    const task: CondensedTask = {
      id: 't1',
      status: 'completed',
      dependsOn: null,
      humanActionPending: true,
      workers: [{
        id: 'w1', status: 'completed',
        prUrl: 'https://github.com/org/repo/pull/102',
        prNumber: 102,
        prLifecycleStatus: 'merged',
        mergedAt: null,
        completedAt: null, startedAt: null, currentAction: null, waitingFor: null, branch: null,
      }],
    };
    const groups = groupTimelineTasks([task], new Map([['t1', task]]));
    expect(groups.waitingOnYou).toHaveLength(0);
    expect(groups.done.map(t => t.id)).toContain('t1');
  });

  it('closed (prLifecycleStatus=closed) → done, not waitingOnYou', () => {
    const task: CondensedTask = {
      id: 't1',
      status: 'completed',
      dependsOn: null,
      humanActionPending: true,
      workers: [{
        id: 'w1', status: 'completed',
        prUrl: 'https://github.com/org/repo/pull/103',
        prNumber: 103,
        prLifecycleStatus: 'closed',
        mergedAt: null,
        completedAt: null, startedAt: null, currentAction: null, waitingFor: null, branch: null,
      }],
    };
    const groups = groupTimelineTasks([task], new Map([['t1', task]]));
    expect(groups.waitingOnYou).toHaveLength(0);
    expect(groups.done.map(t => t.id)).toContain('t1');
  });

  it('escalated (humanActionPending: true) → waitingOnYou', () => {
    const task: CondensedTask = {
      id: 't1',
      status: 'completed',
      dependsOn: null,
      humanActionPending: true,
      workers: [{
        id: 'w1', status: 'completed',
        prUrl: 'https://github.com/org/repo/pull/104',
        prNumber: 104,
        prLifecycleStatus: 'pr_open',
        mergedAt: null,
        completedAt: null, startedAt: null, currentAction: null, waitingFor: null, branch: null,
      }],
    };
    const groups = groupTimelineTasks([task], new Map([['t1', task]]));
    expect(groups.waitingOnYou.map(t => t.id)).toContain('t1');
    expect(groups.done).toHaveLength(0);
  });
});

// ─── gateChipCollapsed — I-11 ─────────────────────────────────────────────────

describe('gateChipCollapsed', () => {
  it('chip is visible (not collapsed) when mergedAt is null', () => {
    expect(gateChipCollapsed(null)).toBe(false);
  });

  it('chip is visible (not collapsed) when mergedAt is undefined', () => {
    expect(gateChipCollapsed(undefined)).toBe(false);
  });

  it('chip collapses when mergedAt is a timestamp string', () => {
    expect(gateChipCollapsed('2026-01-01T00:00:00Z')).toBe(true);
  });

  it('chip collapses when mergedAt is any non-empty string', () => {
    expect(gateChipCollapsed('2024-08-02T12:34:56.789Z')).toBe(true);
  });
});
