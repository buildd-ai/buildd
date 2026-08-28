import { describe, it, expect } from 'bun:test';
import { groupTimelineTasks, groupChainUnits, identifyChains, gateChipCollapsed, deriveBandKey, deriveBandLabel, deriveDayBands } from './condensed-timeline';
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

// ─── deriveBandLabel — §3.8 ──────────────────────────────────────────────────

describe('deriveBandLabel', () => {
  const now = new Date('2026-08-18T14:00:00Z');

  it('returns Today for a timestamp earlier today', () => {
    const ts = new Date('2026-08-18T08:00:00Z').getTime();
    expect(deriveBandLabel(ts, now)).toBe('Today');
  });

  it('returns Yesterday for yesterday', () => {
    const ts = new Date('2026-08-17T10:00:00Z').getTime();
    expect(deriveBandLabel(ts, now)).toBe('Yesterday');
  });

  it('returns weekday name for within last 7 days', () => {
    const ts = new Date('2026-08-14T10:00:00Z').getTime(); // Friday
    const label = deriveBandLabel(ts, now);
    expect(label).toBe('Friday');
  });

  it('returns Mon D format for within current year', () => {
    const ts = new Date('2026-01-05T10:00:00Z').getTime();
    expect(deriveBandLabel(ts, now)).toBe('Jan 5');
  });

  it('returns Mon D, Year for prior year', () => {
    const ts = new Date('2025-03-15T10:00:00Z').getTime();
    expect(deriveBandLabel(ts, now)).toBe('Mar 15, 2025');
  });
});

// ─── deriveBandKey — §3.8 ────────────────────────────────────────────────────

describe('deriveBandKey', () => {
  const now = new Date('2026-08-18T14:00:00Z');
  const mk = (id: string, iso: string) => ({ id, completionTs: new Date(iso).getTime() });

  it('returns empty array for empty input', () => {
    expect(deriveBandKey([], now)).toHaveLength(0);
  });

  it('returns one band for a single item', () => {
    const bands = deriveBandKey([mk('t1', '2026-08-18T10:00:00Z')], now);
    expect(bands).toHaveLength(1);
    expect(bands[0].label).toBe('Today');
    expect(bands[0].items.map(i => i.id)).toEqual(['t1']);
  });

  it('groups two items < 4h apart into the same band', () => {
    const bands = deriveBandKey([
      mk('t1', '2026-08-18T08:00:00Z'),
      mk('t2', '2026-08-18T09:00:00Z'),
    ], now);
    expect(bands).toHaveLength(1);
    expect(bands[0].items).toHaveLength(2);
  });

  it('splits two items exactly 4h apart into separate bands', () => {
    const bands = deriveBandKey([
      mk('t1', '2026-08-17T06:00:00Z'),
      mk('t2', '2026-08-17T10:00:00Z'),
    ], now);
    expect(bands).toHaveLength(2);
  });

  it('returns bands newest-first', () => {
    const bands = deriveBandKey([
      mk('old', '2026-08-16T10:00:00Z'),
      mk('new', '2026-08-18T10:00:00Z'),
    ], now);
    expect(bands[0].label).toBe('Today');
    expect(bands[1].label).toBe('Sunday');
  });

  it('within a band items are newest-first', () => {
    const bands = deriveBandKey([
      mk('t1', '2026-08-18T08:00:00Z'),
      mk('t2', '2026-08-18T09:00:00Z'),
    ], now);
    expect(bands[0].items[0].id).toBe('t2');
    expect(bands[0].items[1].id).toBe('t1');
  });

  it('appends ordinal suffix to duplicate band labels', () => {
    // Two bands, both "Yesterday", separated by >= 4h
    const bands = deriveBandKey([
      mk('t1', '2026-08-17T01:00:00Z'),
      mk('t2', '2026-08-17T06:00:00Z'),
    ], now);
    expect(bands).toHaveLength(2);
    const labels = bands.map(b => b.label);
    expect(labels).toContain('Yesterday');
    expect(labels).toContain('Yesterday (2)');
  });
});

// ─── deriveDayBands — Activity groups by day, not by wave ────────────────────

describe('deriveDayBands', () => {
  const now = new Date('2026-08-18T14:00:00Z');
  const mk = (id: string, iso: string) => ({ id, completionTs: new Date(iso).getTime() });

  it('returns empty array for empty input', () => {
    expect(deriveDayBands([], now)).toHaveLength(0);
  });

  it('keeps same-day items in one band even when > 4h apart (regression: duplicate "Today" header)', () => {
    const bands = deriveDayBands([
      mk('t1', '2026-08-18T08:00:00Z'),
      mk('t2', '2026-08-18T14:00:00Z'),
    ], now);
    expect(bands).toHaveLength(1);
    expect(bands[0].label).toBe('Today');
    expect(bands[0].items).toHaveLength(2);
  });

  it('never emits an ordinal-suffixed label', () => {
    const bands = deriveDayBands([
      mk('t1', '2026-08-17T08:00:00Z'),
      mk('t2', '2026-08-17T11:00:00Z'),
      mk('t3', '2026-08-17T14:00:00Z'),
    ], now);
    expect(bands).toHaveLength(1);
    expect(bands[0].label).toBe('Yesterday');
  });

  it('splits distinct calendar days into separate bands, newest day first', () => {
    const bands = deriveDayBands([
      mk('old', '2026-08-16T12:00:00Z'),
      mk('mid', '2026-08-17T12:00:00Z'),
      mk('new', '2026-08-18T12:00:00Z'),
    ], now);
    expect(bands.map(b => b.label)).toEqual(['Today', 'Yesterday', 'Sunday']);
  });

  it('orders items newest-first within a band', () => {
    const bands = deriveDayBands([
      mk('t1', '2026-08-18T08:00:00Z'),
      mk('t2', '2026-08-18T14:00:00Z'),
      mk('t3', '2026-08-18T11:00:00Z'),
    ], now);
    expect(bands[0].items.map(i => i.id)).toEqual(['t2', 't3', 't1']);
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

// ─── identifyChains ───────────────────────────────────────────────────────────

describe('identifyChains', () => {
  // Helper: pending task with merged-PR dep (gate satisfied)
  function mergedTask(id: string): CondensedTask {
    return withWorker(makeTask({ id, status: 'completed' }), doneWorker({
      prUrl: 'https://github.com/org/repo/pull/1',
      mergedAt: '2025-01-01T00:00:00Z',
    }));
  }

  // 8-deep linear chain: T1→T2→...→T8 (each depends on the previous)
  it('identifies an 8-deep linear chain', () => {
    const tasks: CondensedTask[] = Array.from({ length: 8 }, (_, i) => ({
      id: `t${i + 1}`,
      status: 'pending',
      dependsOn: i === 0 ? null : [`t${i}`],
      workers: [],
    }));
    const taskMap = new Map(tasks.map(t => [t.id, t]));
    const chains = identifyChains(tasks, taskMap);

    expect(chains).toHaveLength(1);
    const [chain] = chains;
    expect(chain.head.id).toBe('t1');
    expect(chain.tail.map(t => t.id)).toEqual(['t2', 't3', 't4', 't5', 't6', 't7', 't8']);
    expect(chain.shape).toBe('linear');
  });

  // Fan-out: T1 has 3 unresolved dependents (T2, T3, T4)
  it('identifies a fan-out chain (1 head, 3 dependents)', () => {
    const head = makeTask({ id: 't1', status: 'pending', dependsOn: null });
    const dep1 = makeTask({ id: 't2', status: 'pending', dependsOn: ['t1'] });
    const dep2 = makeTask({ id: 't3', status: 'pending', dependsOn: ['t1'] });
    const dep3 = makeTask({ id: 't4', status: 'pending', dependsOn: ['t1'] });
    const tasks = [head, dep1, dep2, dep3];
    const taskMap = new Map(tasks.map(t => [t.id, t]));
    const chains = identifyChains(tasks, taskMap);

    expect(chains).toHaveLength(1);
    const [chain] = chains;
    expect(chain.head.id).toBe('t1');
    expect(chain.tail.map(t => t.id)).toEqual(expect.arrayContaining(['t2', 't3', 't4']));
    expect(chain.shape).toBe('fan-out');
  });

  // Fan-in: T3 depends on both T1 and T2 → T3 is a standalone fan-in
  it('identifies a fan-in as a standalone chain', () => {
    const t1 = makeTask({ id: 't1', status: 'pending', dependsOn: null });
    const t2 = makeTask({ id: 't2', status: 'pending', dependsOn: null });
    const t3 = makeTask({ id: 't3', status: 'pending', dependsOn: ['t1', 't2'] });
    const tasks = [t1, t2, t3];
    const taskMap = new Map(tasks.map(t => [t.id, t]));
    const chains = identifyChains(tasks, taskMap);

    // t1 and t2 are standalone, t3 is fan-in standalone
    const t3Chain = chains.find(c => c.head.id === 't3');
    expect(t3Chain).toBeDefined();
    expect(t3Chain!.shape).toBe('fan-in');
    expect(t3Chain!.tail).toHaveLength(0);
  });

  // Standalone: single task with no deps and no dependents
  it('wraps a standalone task as a chain of 1', () => {
    const task = makeTask({ id: 't1', status: 'pending', dependsOn: null });
    const taskMap = new Map([['t1', task]]);
    const chains = identifyChains([task], taskMap);

    expect(chains).toHaveLength(1);
    expect(chains[0].head.id).toBe('t1');
    expect(chains[0].tail).toHaveLength(0);
    expect(chains[0].shape).toBe('standalone');
  });

  // Cycle guard: A→B→A — must not hang
  it('handles a cyclic dep A→B→A without hanging', () => {
    const t1 = makeTask({ id: 't1', status: 'pending', dependsOn: ['t2'] });
    const t2 = makeTask({ id: 't2', status: 'pending', dependsOn: ['t1'] });
    const tasks = [t1, t2];
    const taskMap = new Map(tasks.map(t => [t.id, t]));
    // Must not throw or hang — just return some chains
    let chains: ReturnType<typeof identifyChains>;
    expect(() => {
      chains = identifyChains(tasks, taskMap);
    }).not.toThrow();
    // All tasks should appear somewhere (no tasks lost)
    const allIds = chains!.flatMap(c => [c.head.id, ...c.tail.map(t => t.id)]);
    expect(allIds).toContain('t1');
    expect(allIds).toContain('t2');
  });

  // Linear chain with resolved (gate-satisfied) head dep — head still has no UNRESOLVED blocker
  it('treats a task with only resolved blockers as a chain head', () => {
    const resolved = mergedTask('dep1');
    const head = makeTask({ id: 't1', status: 'pending', dependsOn: ['dep1'] });
    const tail = makeTask({ id: 't2', status: 'pending', dependsOn: ['t1'] });
    const tasks = [resolved, head, tail];
    const taskMap = new Map(tasks.map(t => [t.id, t]));
    const chains = identifyChains(tasks, taskMap);

    // dep1 is resolved — t1 has no unresolved blocker → t1 is a chain head
    // t1→t2 should be a linear chain of 2
    const headChain = chains.find(c => c.head.id === 't1');
    expect(headChain).toBeDefined();
    expect(headChain!.tail.map(t => t.id)).toEqual(['t2']);
    expect(headChain!.shape).toBe('linear');
  });
});

// ─── groupChainUnits ─────────────────────────────────────────────────────────

describe('groupChainUnits', () => {
  // The canonical chain-severing bug: A (waitingOnYou) → B (blocked)
  // Both should end up in waitingOnYou because A is the head.
  it('places a 2-task chain in the section of the head (fixes chain-severing)', () => {
    const head = withWorker(makeTask({ id: 'A', status: 'completed' }), doneWorker({
      prUrl: 'https://github.com/org/repo/pull/1',
      prNumber: 1,
      prLifecycleStatus: 'open',
      mergedAt: null,
    }));
    const tail = makeTask({ id: 'B', status: 'pending', dependsOn: ['A'] });
    const tasks = [head, tail];
    const taskMap = new Map(tasks.map(t => [t.id, t]));
    const groups = groupChainUnits(tasks, taskMap);

    // A is waitingOnYou (completed + open PR); B is blocked on A
    // Both should be in waitingOnYou as one chain
    expect(groups.waitingOnYou).toHaveLength(1);
    expect(groups.blocked).toHaveLength(0);
    const [chain] = groups.waitingOnYou;
    expect(chain.head.id).toBe('A');
    expect(chain.tail.map(t => t.id)).toEqual(['B']);
  });

  // 8-deep chain — all in nextQueued (head has no deps, so nextQueued)
  it('places an 8-deep chain all in nextQueued based on head readiness', () => {
    const tasks: CondensedTask[] = Array.from({ length: 8 }, (_, i) => ({
      id: `t${i + 1}`,
      status: 'pending',
      dependsOn: i === 0 ? null : [`t${i}`],
      workers: [],
    }));
    const taskMap = new Map(tasks.map(t => [t.id, t]));
    const groups = groupChainUnits(tasks, taskMap);

    // Head t1 has no deps → nextQueued
    expect(groups.nextQueued).toHaveLength(1);
    expect(groups.blocked).toHaveLength(0);
    const [chain] = groups.nextQueued;
    expect(chain.head.id).toBe('t1');
    expect(chain.tail).toHaveLength(7);
  });

  // Fan-out: head is running, dependents follow into running
  it('places a fan-out chain in running when head has a live worker', () => {
    const head = withWorker(makeTask({ id: 'A', status: 'pending', dependsOn: null }), { status: 'running' });
    const dep1 = makeTask({ id: 'B', status: 'pending', dependsOn: ['A'] });
    const dep2 = makeTask({ id: 'C', status: 'pending', dependsOn: ['A'] });
    const tasks = [head, dep1, dep2];
    const taskMap = new Map(tasks.map(t => [t.id, t]));
    const groups = groupChainUnits(tasks, taskMap);

    expect(groups.running).toHaveLength(1);
    const [chain] = groups.running;
    expect(chain.head.id).toBe('A');
    expect(chain.shape).toBe('fan-out');
    expect(chain.tail.map(t => t.id)).toEqual(expect.arrayContaining(['B', 'C']));
  });

  // Standalone task without deps → nextQueued
  it('places a standalone task in the correct section', () => {
    const task = makeTask({ id: 't1', status: 'pending', dependsOn: null });
    const taskMap = new Map([['t1', task]]);
    const groups = groupChainUnits([task], taskMap);

    expect(groups.nextQueued).toHaveLength(1);
    const [chain] = groups.nextQueued;
    expect(chain.head.id).toBe('t1');
    expect(chain.tail).toHaveLength(0);
    expect(chain.shape).toBe('standalone');
  });
});
