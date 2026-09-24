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

const mockTasksFindMany = mock((_args?: any) => Promise.resolve(recentTaskRows));

// ── mission notes (planning-backoff note dedupe) ──
let openBackoffNote: { id: string; body: string } | undefined;
let noteUpdateCalls: Array<{ set: any; where: any }> = [];
const mockNotesFindFirst = mock((_args?: any) => Promise.resolve(openBackoffNote));

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
      missionNotes: { findFirst: mockNotesFindFirst },
    },
    update: (table: any) => {
      if (table === 'taskSchedules') return mockScheduleUpdate();
      if (table === 'missionNotes') {
        return {
          set: (data: any) => ({
            where: (w: any) => { noteUpdateCalls.push({ set: data, where: w }); return Promise.resolve(); },
          }),
        };
      }
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
  computeHeartbeatPlanningBackoff,
  evaluateHeartbeatPlanningBackoff,
  applyHeartbeatPlanningBackoff,
  resolveHeartbeatPlanningBackoffNote,
  HEARTBEAT_PLANNING_BACKOFF_THRESHOLD,
  HEARTBEAT_PLANNING_BACKOFF_BASE_MS,
  HEARTBEAT_PLANNING_BACKOFF_MAX_MS,
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

// ── Planning-failure backoff ────────────────────────────────────────────────
// The died-early breaker above never fires on an organizer that works for a
// dozen turns and then fails the cycle (no confirmed outcome, no structured
// plan). Those cycles cost real turns, and the cron re-dispatched them on
// every tick with no backoff.

const NOW_MS = Date.parse('2026-09-01T12:00:00.000Z');
const minutesAgo = (m: number) => new Date(NOW_MS - m * 60_000);

function failedCycle(id: string, failedMinutesAgo: number) {
  return {
    id,
    status: 'failed',
    createdAt: minutesAgo(failedMinutesAgo + 20),
    failedAt: minutesAgo(failedMinutesAgo),
  } as any;
}

describe('computeHeartbeatPlanningBackoff', () => {
  it('3 failed cycles → no dispatch on the 4th tick', () => {
    const r = computeHeartbeatPlanningBackoff(
      [failedCycle('t-3', 30), failedCycle('t-2', 60), failedCycle('t-1', 90)],
      new Date(NOW_MS),
    );
    expect(r.active).toBe(true);
    expect(r.streak).toBe(3);
    expect(r.resumeAt!.getTime()).toBeGreaterThan(NOW_MS);
  });

  it('fewer than K consecutive failures → no backoff', () => {
    const r = computeHeartbeatPlanningBackoff(
      [failedCycle('t-2', 30), failedCycle('t-1', 60)],
      new Date(NOW_MS),
    );
    expect(r.active).toBe(false);
  });

  it('a success resets the streak', () => {
    const r = computeHeartbeatPlanningBackoff(
      [
        { id: 't-4', status: 'completed', createdAt: minutesAgo(10), failedAt: null } as any,
        failedCycle('t-3', 30), failedCycle('t-2', 60), failedCycle('t-1', 90),
      ],
      new Date(NOW_MS),
    );
    expect(r.active).toBe(false);
    expect(r.streak).toBe(0);
  });

  it('the wait doubles with each further failure and is capped', () => {
    const at3 = computeHeartbeatPlanningBackoff(
      [failedCycle('c', 0), failedCycle('b', 30), failedCycle('a', 60)],
      new Date(NOW_MS),
    );
    const at4 = computeHeartbeatPlanningBackoff(
      [failedCycle('d', 0), failedCycle('c', 30), failedCycle('b', 60), failedCycle('a', 90)],
      new Date(NOW_MS),
    );
    const wait3 = at3.resumeAt!.getTime() - NOW_MS;
    const wait4 = at4.resumeAt!.getTime() - NOW_MS;
    expect(wait4).toBe(wait3 * 2);

    const many = Array.from({ length: 30 }, (_, i) => failedCycle(`t-${i}`, i * 30));
    const capped = computeHeartbeatPlanningBackoff(many, new Date(NOW_MS));
    expect(capped.resumeAt!.getTime() - NOW_MS).toBe(HEARTBEAT_PLANNING_BACKOFF_MAX_MS);
  });

  it('anchors on when the cycle failed, not on a later write to the task row', () => {
    // A reconcile/cleanup sweep that bumps tasks.updatedAt must not extend the
    // hold: the row carries no updatedAt the pure function would read.
    const r = computeHeartbeatPlanningBackoff(
      [
        { ...failedCycle('t-3', 90), updatedAt: new Date(NOW_MS) },
        failedCycle('t-2', 120),
        failedCycle('t-1', 150),
      ],
      new Date(NOW_MS),
    );
    expect(r.resumeAt!.getTime()).toBe(minutesAgo(90).getTime() + HEARTBEAT_PLANNING_BACKOFF_BASE_MS);
    expect(r.active).toBe(false);
  });

  it('falls back to createdAt when the failure time is unknown', () => {
    const r = computeHeartbeatPlanningBackoff(
      [{ id: 't-3', status: 'failed', createdAt: minutesAgo(30), failedAt: null } as any, failedCycle('t-2', 60), failedCycle('t-1', 90)],
      new Date(NOW_MS),
    );
    expect(r.resumeAt!.getTime()).toBe(minutesAgo(30).getTime() + HEARTBEAT_PLANNING_BACKOFF_BASE_MS);
  });

  it('lets a cycle through once the backoff window has elapsed', () => {
    const r = computeHeartbeatPlanningBackoff(
      [failedCycle('t-3', 24 * 60), failedCycle('t-2', 25 * 60), failedCycle('t-1', 26 * 60)],
      new Date(NOW_MS),
    );
    expect(r.streak).toBe(3);
    expect(r.active).toBe(false);
  });
});

describe('evaluateHeartbeatPlanningBackoff', () => {
  beforeEach(() => {
    recentTaskRows = [];
    mockTasksFindMany.mockClear();
  });

  function workerFailedCycle(id: string, completedMsAgo: number, now: number) {
    return {
      id,
      status: 'failed',
      createdAt: new Date(now - completedMsAgo - 20 * 60_000),
      // Row bumped long after the failure; must not be the anchor.
      updatedAt: new Date(now),
      workers: [{ completedAt: new Date(now - completedMsAgo) }],
    } as any;
  }

  it("reads this schedule's recent cycles and anchors on the latest worker's completedAt", async () => {
    const now = Date.now();
    recentTaskRows = [
      workerFailedCycle('t-3', 60_000, now),
      workerFailedCycle('t-2', 31 * 60_000, now),
      workerFailedCycle('t-1', 61 * 60_000, now),
    ];
    const r = await evaluateHeartbeatPlanningBackoff({
      missionId: 'm-1',
      scheduleId: 's-1',
      heartbeatBreakerTrippedAt: null,
    }, new Date(now));
    expect(r.active).toBe(true);
    expect(r.streak).toBe(HEARTBEAT_PLANNING_BACKOFF_THRESHOLD);
    expect(r.resumeAt!.getTime()).toBe(now - 60_000 + HEARTBEAT_PLANNING_BACKOFF_BASE_MS);
  });

  it('floors the window at heartbeatBreakerTrippedAt, so a re-armed mission starts fresh', async () => {
    const trippedAt = new Date(NOW_MS - 5 * 60_000);
    await evaluateHeartbeatPlanningBackoff({ missionId: 'm-1', scheduleId: 's-1', heartbeatBreakerTrippedAt: trippedAt });
    const where = (mockTasksFindMany.mock.calls[0][0] as any).where;
    expect(where.args).toContainEqual({ field: undefined, value: trippedAt, type: 'gt' });
    expect(where.args.filter((a: any) => a.type === 'gt')).toHaveLength(1);
  });

  it('applies no window floor when the breaker never tripped', async () => {
    await evaluateHeartbeatPlanningBackoff({ missionId: 'm-1', scheduleId: 's-1', heartbeatBreakerTrippedAt: null });
    const where = (mockTasksFindMany.mock.calls[0][0] as any).where;
    expect(where.args.filter((a: any) => a.type === 'gt')).toHaveLength(0);
  });
});

describe('applyHeartbeatPlanningBackoff', () => {
  const backoff = { active: true, streak: 4, resumeAt: new Date(NOW_MS + 2 * 60 * 60_000) };

  beforeEach(() => {
    insertedNotes = [];
    noteUpdateCalls = [];
    scheduleUpdateSetData = null;
    openBackoffNote = undefined;
  });

  it('holds the schedule until resumeAt and posts a note when none is open', async () => {
    await applyHeartbeatPlanningBackoff({ missionId: 'm-1', scheduleId: 's-1', backoff });
    expect(scheduleUpdateSetData.nextRunAt).toEqual(backoff.resumeAt);
    expect(scheduleUpdateSetData.lastDeferralReason).toBe('heartbeat_planning_backoff');
    expect(insertedNotes).toHaveLength(1);
    expect(insertedNotes[0].status).toBe('open');
  });

  it('updates the open note in place on each later backoff step instead of posting another', async () => {
    openBackoffNote = { id: 'note-1', body: 'older step' };
    await applyHeartbeatPlanningBackoff({ missionId: 'm-1', scheduleId: 's-1', backoff });
    expect(insertedNotes).toHaveLength(0);
    expect(noteUpdateCalls).toHaveLength(1);
    expect(noteUpdateCalls[0].set.body).toContain(backoff.resumeAt.toISOString());
  });
});

describe('resolveHeartbeatPlanningBackoffNote', () => {
  beforeEach(() => { noteUpdateCalls = []; });

  it('supersedes the open backoff note', async () => {
    await resolveHeartbeatPlanningBackoffNote('m-1');
    expect(noteUpdateCalls).toHaveLength(1);
    expect(noteUpdateCalls[0].set.status).toBe('superseded');
  });
});
