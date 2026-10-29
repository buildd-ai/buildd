/**
 * Health › Queue's view (spec "Health › Queue"): the AC table on the pure
 * builder. The loader (lib/health-queue.ts) only reads; every number and word
 * the tab shows is decided here.
 */
import { describe, it, expect } from 'bun:test';
import type { QueueWait } from '@buildd/shared';
import { buildHealthQueueView, type HealthQueueViewInput, type HealthQueueTaskInput } from './health-queue-view';

const NOW = Date.parse('2026-10-23T12:00:00Z');
const HOUR = 3600_000;

let n = 0;
function task(wait: QueueWait | null, over: Partial<HealthQueueTaskInput> = {}): HealthQueueTaskInput {
  n += 1;
  return { id: `t-${n}`, title: `Task ${n}`, workspaceId: 'ws-1', missionTitle: null, createdAt: new Date(NOW - n * HOUR).toISOString(), wait, ...over };
}

function input(over: Partial<HealthQueueViewInput> = {}): HealthQueueViewInput {
  return { now: NOW, running: 0, slots: 0, teamBusy: 0, tasks: [], lanes: [], filter: 'all', page: 1, truncated: false, missions: [], ...over };
}

const slot: QueueWait = { kind: 'slot' };
const limit: QueueWait = { kind: 'limit', limit: 'mission_budget', liftsAt: new Date(NOW + 4 * 60_000).toISOString(), forceable: true };
const parked: QueueWait = { kind: 'start_time', startAt: new Date(NOW + 2 * HOUR).toISOString() };

describe('AC-1: tiles', () => {
  it('4 running, 2 ready, 9 waiting and 1 parked across 6 slots read 4/6, 2, 9, 1', () => {
    const tasks = [
      task(slot), task(slot),
      ...Array.from({ length: 5 }, () => task(limit)),
      ...Array.from({ length: 2 }, () => task({ kind: 'declared', blockerId: 'a', blockerTitle: 'A', blockerStatus: 'in_progress', count: 1 })),
      ...Array.from({ length: 2 }, (_, i) => task({ kind: 'lane', lane: 'migration', position: i + 1, holderTaskId: 'h' })),
      task(parked),
    ];
    const v = buildHealthQueueView(input({ running: 4, slots: 6, teamBusy: 4, tasks }));
    expect(buildHealthQueueView(input({ running: 1, slots: 0, capacity: { used: 0, total: 0 } })).tiles.capacity).toEqual({ used: 0, total: 0 });
    expect(v.tiles).toEqual({ running: 4, slots: 6, capacity: { used: 4, total: 6 }, ready: 2, waiting: 9, parked: 1, waitingByReason: { declared: 2, lane: 2, limit: 5 } });
    expect(v.ready.map(r => r.id)).toEqual([tasks[0].id, tasks[1].id]);
    expect(v.parked).toHaveLength(1);
    expect(v.parked[0].starts).toBe('Starts in 2h 00m');
  });
});

describe('AC-2 and R-4: the alert line', () => {
  it('names idle slots and the cause when a ready task no runner serves', () => {
    const v = buildHealthQueueView(input({ slots: 3, teamBusy: 1, tasks: [task({ kind: 'slot', noRunnerReason: 'no reviewer runner online' })] }));
    expect(v.alert).toBe('2 idle slots, 1 task could start · no reviewer runner online');
    // The shared IdleAlert's props: idle slots, tasks that could start, the cause.
    expect(v.idle).toEqual({ slots: 2, tasks: 1, cause: 'no reviewer runner online' });
    expect(v.ready[0].note).toBe('No runner: no reviewer runner online');
  });

  it('nothing wrong: no alert', () => {
    expect(buildHealthQueueView(input({ slots: 2, teamBusy: 2, tasks: [task(slot), task(limit)] })).alert).toBeNull();
    // Idle slots with nothing that could start is not wrong either.
    expect(buildHealthQueueView(input({ slots: 4, teamBusy: 0, tasks: [task(limit)] })).alert).toBeNull();
    expect(buildHealthQueueView(input({ slots: 4, teamBusy: 0, tasks: [task(limit)] })).idle).toBeNull();
  });

  it('a lane holder with no PR activity for 24h: the alert names the stuck lane (AC-4)', () => {
    const v = buildHealthQueueView(input({
      lanes: [{ workspaceId: 'ws-1', lane: 'migration', members: [
        { taskId: 'h', title: 'Add column', holding: true, status: 'completed', prNumber: 12, since: new Date(NOW - 30 * HOUR).toISOString(), stuckSince: new Date(NOW - 26 * HOUR).toISOString() },
        { taskId: 'w', title: 'Next', holding: false, status: 'pending', prNumber: null, since: new Date(NOW - 5 * HOUR).toISOString(), stuckSince: null },
      ] }],
    }));
    expect(v.alert).toBe('Schema lane stuck 26h');
    expect(v.lanes[0].stuckFor).toBe('26h');
  });

  it('worst first: idle slots, then a stuck lane, on one line', () => {
    const v = buildHealthQueueView(input({
      slots: 2, teamBusy: 0, tasks: [task(slot)],
      lanes: [{ workspaceId: 'ws-1', lane: 'migration', members: [
        { taskId: 'h', title: 'H', holding: true, status: 'completed', prNumber: 1, since: null, stuckSince: new Date(NOW - 50 * HOUR).toISOString() },
      ] }],
    }));
    expect(v.alert).toBe('2 idle slots, 1 task could start · Schema lane stuck 2d');
  });
});

describe('AC-3 and R-5: one badge per waiting task', () => {
  it('B declared on A names A; C third in the schema lane reads Schema lane · 3rd', () => {
    const b = task({ kind: 'declared', blockerId: 'a', blockerTitle: 'A', blockerStatus: 'in_progress', count: 1 });
    const c = task({ kind: 'lane', lane: 'migration', position: 3, holderTaskId: 'h' });
    const v = buildHealthQueueView(input({ tasks: [b, c] }));
    const rowB = v.waiting.rows.find(r => r.id === b.id)!;
    const rowC = v.waiting.rows.find(r => r.id === c.id)!;
    expect(rowB.badge).toBe('Declared');
    expect(rowB.blockedBy).toBe('A');
    expect(rowB.blockerId).toBe('a');
    expect(rowC.badge).toBe('Lane');
    expect(rowC.blockedBy).toBe('Schema lane · 3rd');
  });

  it('ready and parked tasks have no badge and are not in the Waiting table', () => {
    const v = buildHealthQueueView(input({ tasks: [task(slot), task(parked)] }));
    expect(v.waiting.rows).toEqual([]);
  });

  it('sorted Lane, Limit, Declared; lanes by position, the rest oldest first', () => {
    const d = task({ kind: 'declared', blockerId: 'a', count: 1 });
    const l1 = task(limit, { createdAt: new Date(NOW - HOUR).toISOString() });
    const l2 = task(limit, { createdAt: new Date(NOW - 9 * HOUR).toISOString() });
    const s2 = task({ kind: 'lane', lane: 'migration', position: 2 });
    const s1 = task({ kind: 'lane', lane: 'migration', position: 1 });
    const v = buildHealthQueueView(input({ tasks: [d, l1, l2, s2, s1] }));
    expect(v.waiting.rows.map(r => r.id)).toEqual([s1.id, s2.id, l2.id, l1.id, d.id]);
  });
});

describe('AC-5, AC-6: lanes', () => {
  it('no lane in use: no lanes', () => {
    expect(buildHealthQueueView(input({ lanes: [{ workspaceId: 'ws-1', lane: 'migration', members: [] }] })).lanes).toEqual([]);
  });

  it('the holder first with its state, then waiters in lane order', () => {
    const v = buildHealthQueueView(input({
      lanes: [{ workspaceId: 'ws-1', lane: 'migration', members: [
        { taskId: 'w1', title: 'First', holding: false, status: 'pending', prNumber: null, since: null, stuckSince: null },
        { taskId: 'h', title: 'Holder', holding: true, status: 'in_progress', prNumber: null, since: new Date(NOW - 2 * HOUR).toISOString(), stuckSince: null },
        { taskId: 'w2', title: 'Second', holding: false, status: 'pending', prNumber: null, since: null, stuckSince: null },
      ] }],
    }));
    const lane = v.lanes[0];
    expect(lane.name).toBe('Schema');
    expect(lane.holder).toMatchObject({ taskId: 'h', state: 'Running', age: '2h', position: null, meter: { state: 'build' } });
    expect(lane.waiters.every(w => w.meter === null)).toBe(true);
    expect(lane.waiters.map(w => [w.taskId, w.position])).toEqual([['w1', 1], ['w2', 2]]);
    expect(lane.stuckFor).toBeNull();
  });

  it('a holder with an open PR reads PR open', () => {
    const v = buildHealthQueueView(input({
      lanes: [{ workspaceId: 'ws-1', lane: 'migration', members: [
        { taskId: 'h', title: 'Holder', holding: true, status: 'completed', prNumber: 7, since: null, stuckSince: null },
      ] }],
    }));
    expect(v.lanes[0].holder?.state).toBe('PR open');
    // Its StageMeter is at Verify once its PR is open (R-8).
    expect(v.lanes[0].holder?.meter).toEqual({ state: 'verify' });
  });

  it('a holder no agent is on yet sits queued on its meter', () => {
    const v = buildHealthQueueView(input({
      lanes: [{ workspaceId: 'ws-1', lane: 'migration', members: [
        { taskId: 'h', title: 'Holder', holding: true, status: 'pending', prNumber: null, since: null, stuckSince: null },
      ] }],
    }));
    expect(v.lanes[0].holder?.meter).toEqual({ state: 'queued' });
  });
});

describe('AC-7: Force start only on Limit rows', () => {
  it('a forceable limit offers it; lane and declared rows never do', () => {
    const v = buildHealthQueueView(input({ tasks: [
      task(limit),
      task({ ...limit, forceable: false }),
      task({ kind: 'lane', lane: 'migration', position: 1 }),
      task({ kind: 'declared', blockerId: 'a', count: 1 }),
    ] }));
    // The unforceable limit is older, so it sorts first.
    expect(v.waiting.rows.map(r => [r.reason, r.forceable])).toEqual([['lane', false], ['limit', false], ['limit', true], ['declared', false]]);
  });
});

describe('AC-10: 400 pending tasks', () => {
  it('50 rows per page, exact tiles, and filter segments', () => {
    const tasks = Array.from({ length: 400 }, (_, i) => task(i % 4 === 0 ? slot : limit));
    const v = buildHealthQueueView(input({ tasks, page: 2 }));
    expect(v.tiles.ready).toBe(100);
    expect(v.tiles.waiting).toBe(300);
    expect(v.waiting.total).toBe(300);
    expect(v.waiting.pages).toBe(6);
    expect(v.waiting.page).toBe(2);
    expect(v.waiting.rows).toHaveLength(50);
    const lane = buildHealthQueueView(input({ tasks, filter: 'lane' }));
    expect(lane.waiting.total).toBe(0);
    expect(lane.waiting.rows).toEqual([]);
    expect(lane.waiting.pages).toBe(1);
  });

  it('a page past the end clamps to the last page', () => {
    const v = buildHealthQueueView(input({ tasks: [task(limit)], page: 9 }));
    expect(v.waiting.page).toBe(1);
    expect(v.waiting.rows).toHaveLength(1);
  });
});

describe('reasons unread', () => {
  it('a task with no read reason is never called ready', () => {
    const v = buildHealthQueueView(input({ tasks: [task(null)], reasonsUnavailable: true }));
    expect(v.tiles.ready).toBe(0);
    expect(v.ready).toEqual([]);
    expect(v.reasonsUnavailable).toBe(true);
  });
});

describe('AC-14 and R-7: Queued rows in claim order', () => {
  it('keep the read\'s order, with their mission and when they were filed', () => {
    const rows = [task(slot, { title: 'C', missionTitle: 'Health' }), task(slot, { title: 'A' }), task(slot, { title: 'B' })];
    const v = buildHealthQueueView(input({ slots: 1, teamBusy: 0, tasks: rows }));
    expect(v.ready.map(r => r.title)).toEqual(['C', 'A', 'B']);
    expect(v.ready[0]).toMatchObject({ missionTitle: 'Health', createdAt: rows[0].createdAt, note: 'Starts now' });
    expect(v.ready.slice(1).map(r => r.note)).toEqual(['Next free slot', 'Next free slot']);
  });

  it('adds ~time from measured run ends, earliest first, and none when nothing is measured', () => {
    const rows = [task(slot), task(slot), task(slot)];
    const now = 10_000_000;
    const v = buildHealthQueueView(input({ now, slots: 2, teamBusy: 2, runEnds: [now + 30 * 60_000, now + 5 * 60_000], tasks: rows }));
    expect(v.ready.map(r => r.note)).toEqual(['Next free slot ~5m', 'Next free slot ~30m', 'Next free slot']);
  });
});
