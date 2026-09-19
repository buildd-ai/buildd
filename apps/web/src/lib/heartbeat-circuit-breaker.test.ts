import { describe, it, expect, beforeEach, mock } from 'bun:test';

// ── db.query.tasks.findMany (evaluateHeartbeatCircuitBreaker) ──
let recentTaskRows: Array<{
  id: string;
  status: string;
  workers: Array<{ status: string; turns: number; costUsd: string; error: string | null }>;
}> = [];

// ── db.update(missions) claim (tripHeartbeatCircuitBreaker) ──
let missionUpdateReturning: any[] = [{ id: 'm-1' }];
let missionUpdateSetData: any = null;
let scheduleUpdateSetData: any = null;
let insertedNotes: any[] = [];

const mockTasksFindMany = mock(() => Promise.resolve(recentTaskRows));

const mockMissionsUpdate = mock(() => ({
  set: mock((data: any) => {
    missionUpdateSetData = data;
    return { where: mock(() => ({ returning: mock(() => Promise.resolve(missionUpdateReturning)) })) };
  }),
}));
const mockScheduleUpdate = mock(() => ({
  set: mock((data: any) => {
    scheduleUpdateSetData = data;
    return { where: mock(() => Promise.resolve()) };
  }),
}));
const mockNotesInsert = mock((vals: any) => {
  insertedNotes.push(vals);
  return Promise.resolve([{ id: `note-${insertedNotes.length}`, ...vals }]);
});

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      tasks: { findMany: mockTasksFindMany },
    },
    update: (table: any) => {
      if (table === 'taskSchedules') return mockScheduleUpdate();
      return mockMissionsUpdate();
    },
    insert: (table: any) => {
      if (table === 'missionNotes') return { values: mockNotesInsert };
      throw new Error(`unexpected db.insert(${table}) in heartbeat-circuit-breaker`);
    },
  },
}));

mock.module('@buildd/core/db/schema', () => ({
  missions: 'missions',
  missionNotes: 'missionNotes',
  taskSchedules: 'taskSchedules',
  tasks: 'tasks',
}));

mock.module('drizzle-orm', () => ({
  and: (...args: any[]) => ({ args, type: 'and' }),
  eq: (field: any, value: any) => ({ field, value, type: 'eq' }),
  gt: (field: any, value: any) => ({ field, value, type: 'gt' }),
  desc: (field: any) => ({ field, type: 'desc' }),
}));

let notifyCalls: any[] = [];
mock.module('./pushover', () => ({
  notify: mock((opts: any) => { notifyCalls.push(opts); }),
}));

import {
  evaluateHeartbeatCircuitBreaker,
  tripHeartbeatCircuitBreaker,
  HEARTBEAT_BREAKER_THRESHOLD,
} from './heartbeat-circuit-breaker';

function diedEarlyTask(id: string): typeof recentTaskRows[number] {
  return {
    id,
    status: 'failed',
    workers: [{ status: 'failed', turns: 1, costUsd: '0', error: 'You have hit your weekly limit' }],
  };
}

function successTask(id: string): typeof recentTaskRows[number] {
  return {
    id,
    status: 'completed',
    workers: [{ status: 'completed', turns: 12, costUsd: '1.50', error: null }],
  };
}

describe('evaluateHeartbeatCircuitBreaker', () => {
  beforeEach(() => {
    recentTaskRows = [];
  });

  it('trips after N consecutive died-early failures', async () => {
    recentTaskRows = [diedEarlyTask('t-3'), diedEarlyTask('t-2'), diedEarlyTask('t-1')];
    const result = await evaluateHeartbeatCircuitBreaker({
      missionId: 'm-1',
      scheduleId: 's-1',
      heartbeatBreakerTrippedAt: null,
    });
    expect(result.tripped).toBe(true);
    expect(result.count).toBe(HEARTBEAT_BREAKER_THRESHOLD);
    expect(result.errorSignature.length).toBeGreaterThan(0);
  });

  it('does not trip when a success is mixed in', async () => {
    recentTaskRows = [successTask('t-3'), diedEarlyTask('t-2'), diedEarlyTask('t-1')];
    const result = await evaluateHeartbeatCircuitBreaker({
      missionId: 'm-1',
      scheduleId: 's-1',
      heartbeatBreakerTrippedAt: null,
    });
    expect(result.tripped).toBe(false);
  });

  it('does not trip when fewer than N tasks exist yet', async () => {
    recentTaskRows = [diedEarlyTask('t-2'), diedEarlyTask('t-1')];
    const result = await evaluateHeartbeatCircuitBreaker({
      missionId: 'm-1',
      scheduleId: 's-1',
      heartbeatBreakerTrippedAt: null,
    });
    expect(result.tripped).toBe(false);
  });

  it('does not trip on a failure that is not died-early (real work happened)', async () => {
    recentTaskRows = [
      { id: 't-3', status: 'failed', workers: [{ status: 'failed', turns: 8, costUsd: '2.10', error: 'real bug' }] },
      diedEarlyTask('t-2'),
      diedEarlyTask('t-1'),
    ];
    const result = await evaluateHeartbeatCircuitBreaker({
      missionId: 'm-1',
      scheduleId: 's-1',
      heartbeatBreakerTrippedAt: null,
    });
    expect(result.tripped).toBe(false);
  });

  it('does not trip when a task in the window has no worker row (unclassifiable, fail open)', async () => {
    recentTaskRows = [
      { id: 't-3', status: 'failed', workers: [] },
      diedEarlyTask('t-2'),
      diedEarlyTask('t-1'),
    ];
    const result = await evaluateHeartbeatCircuitBreaker({
      missionId: 'm-1',
      scheduleId: 's-1',
      heartbeatBreakerTrippedAt: null,
    });
    expect(result.tripped).toBe(false);
  });
});

describe('tripHeartbeatCircuitBreaker', () => {
  beforeEach(() => {
    missionUpdateReturning = [{ id: 'm-1' }];
    missionUpdateSetData = null;
    scheduleUpdateSetData = null;
    insertedNotes = [];
    notifyCalls = [];
  });

  it('pauses the mission, disables the schedule, posts one note, and notifies', async () => {
    const result = await tripHeartbeatCircuitBreaker({
      missionId: 'm-1',
      missionTitle: 'My Mission',
      scheduleId: 's-1',
      count: 3,
      errorSignature: 'weekly limit',
    });

    expect(result.tripped).toBe(true);
    expect(missionUpdateSetData.status).toBe('paused');
    expect(missionUpdateSetData.heartbeatBreakerTrippedAt).toBeInstanceOf(Date);
    expect(scheduleUpdateSetData.enabled).toBe(false);
    expect(scheduleUpdateSetData.lastDeferralReason).toBe('heartbeat_circuit_breaker');
    expect(insertedNotes.length).toBe(1);
    expect(insertedNotes[0].type).toBe('warning');
    expect(insertedNotes[0].body).toContain('weekly limit');
    expect(notifyCalls.length).toBe(1);
    expect(notifyCalls[0].title).toContain('My Mission');
  });

  it('is idempotent — a second call on an already-paused mission is a no-op', async () => {
    missionUpdateReturning = []; // the atomic UPDATE...WHERE status='active' claimed nothing
    const result = await tripHeartbeatCircuitBreaker({
      missionId: 'm-1',
      missionTitle: 'My Mission',
      scheduleId: 's-1',
      count: 3,
      errorSignature: 'weekly limit',
    });

    expect(result.tripped).toBe(false);
    expect(insertedNotes.length).toBe(0);
    expect(notifyCalls.length).toBe(0);
  });
});
