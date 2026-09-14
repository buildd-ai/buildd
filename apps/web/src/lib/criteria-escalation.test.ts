import { describe, it, expect, beforeEach, mock } from 'bun:test';

let missionRow: any = null;
let scheduleRow: any = null;

let missionUpdateSetData: any = null;
let noteUpdateSetData: any = null;
let scheduleUpdateSetData: any = null;

// Controls the outcome of escalateCriteriaFailure's atomic UPDATE ... RETURNING
// claim: non-empty = claimed (proceed), empty = another caller already holds
// this exact fingerprint (no-op).
let missionUpdateReturning: any[] = [{ id: 'm-1' }];
let insertedNotes: any[] = [];

const mockMissionsFindFirst = mock(() => Promise.resolve(missionRow));
const mockScheduleFindFirst = mock(() => Promise.resolve(scheduleRow));

const mockMissionsUpdate = mock(() => ({
  set: mock((data: any) => {
    missionUpdateSetData = data;
    return {
      where: mock(() => ({
        returning: mock(() => Promise.resolve(missionUpdateReturning)),
      })),
    };
  }),
}));
const mockNotesUpdate = mock(() => ({
  set: mock((data: any) => {
    noteUpdateSetData = data;
    return { where: mock(() => Promise.resolve()) };
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
      missions: { findFirst: mockMissionsFindFirst },
      taskSchedules: { findFirst: mockScheduleFindFirst },
    },
    update: (table: any) => {
      if (table === 'taskSchedules') return mockScheduleUpdate();
      if (table === 'missionNotes') return mockNotesUpdate();
      return mockMissionsUpdate();
    },
    // Only `missionNotes` inserts are supported — resolveCriteriaEscalation
    // must never file a task, so an insert on any other table fails the test
    // suite loudly (TypeError) instead of silently succeeding.
    insert: (table: any) => {
      if (table === 'missionNotes') return { values: mockNotesInsert };
      throw new Error(`unexpected db.insert(${table}) in criteria-escalation`);
    },
  },
}));

mock.module('@buildd/core/db/schema', () => ({
  missions: 'missions',
  missionNotes: 'missionNotes',
  taskSchedules: 'taskSchedules',
}));

mock.module('drizzle-orm', () => ({
  eq: (field: any, value: any) => ({ field, value, type: 'eq' }),
  and: (...args: any[]) => ({ args, type: 'and' }),
  sql: (strings: TemplateStringsArray, ...values: any[]) => ({ strings, values, type: 'sql' }),
}));

let feedEvents: any[] = [];
const mockPostMissionFeedEvent = mock((opts: any) => {
  feedEvents.push(opts);
  return Promise.resolve();
});
mock.module('@/lib/mission-feed', () => ({
  postMissionFeedEvent: mockPostMissionFeedEvent,
}));

import { resolveCriteriaEscalation, escalateCriteriaFailure } from './criteria-escalation';

const systemActor = { kind: 'system' as const, id: null, label: 'test' };

describe('resolveCriteriaEscalation', () => {
  beforeEach(() => {
    missionRow = { id: 'm-1', criteriaEscalatedAt: new Date('2026-09-01T00:00:00Z'), scheduleId: 'sched-1' };
    scheduleRow = { id: 'sched-1' };
    missionUpdateSetData = null;
    noteUpdateSetData = null;
    scheduleUpdateSetData = null;
    feedEvents = [];
    mockMissionsFindFirst.mockClear();
    mockScheduleFindFirst.mockClear();
    mockMissionsUpdate.mockClear();
    mockNotesUpdate.mockClear();
    mockScheduleUpdate.mockClear();
    mockPostMissionFeedEvent.mockClear();
  });

  it('is a no-op on a mission with no escalation — files no tasks, touches nothing', async () => {
    missionRow = { id: 'm-1', criteriaEscalatedAt: null, scheduleId: 'sched-1' };

    const result = await resolveCriteriaEscalation('m-1', 'mission_completed', systemActor);

    expect(result.cleared).toBe(false);
    expect(mockMissionsUpdate).not.toHaveBeenCalled();
    expect(mockNotesUpdate).not.toHaveBeenCalled();
    expect(mockScheduleUpdate).not.toHaveBeenCalled();
    expect(feedEvents).toHaveLength(0);
  });

  it('clears the flag, closes the note as answered, re-enables an existing schedule, and posts one feed note', async () => {
    const result = await resolveCriteriaEscalation('m-1', 'mission_completed', systemActor);

    expect(result.cleared).toBe(true);
    expect(missionUpdateSetData.criteriaEscalatedAt).toBeNull();
    expect(noteUpdateSetData.status).toBe('answered');
    expect(scheduleUpdateSetData.enabled).toBe(true);
    expect(scheduleUpdateSetData.lastDeferralReason).toBeNull();
    expect(mockMissionsUpdate).toHaveBeenCalledTimes(1);
    expect(mockNotesUpdate).toHaveBeenCalledTimes(1);
    expect(mockScheduleUpdate).toHaveBeenCalledTimes(1);
    expect(feedEvents).toHaveLength(1);
    expect(feedEvents[0].title).toMatch(/escalation cleared/i);
    expect(feedEvents[0].body).toMatch(/mission was completed/i);
    expect(feedEvents[0].body).toMatch(/heartbeat re-enabled/i);
  });

  it('does not touch a schedule row that was already deleted (mission closed)', async () => {
    scheduleRow = null;

    const result = await resolveCriteriaEscalation('m-1', 'criteria_edited', systemActor);

    expect(result.cleared).toBe(true);
    expect(mockScheduleUpdate).not.toHaveBeenCalled();
    expect(feedEvents[0].body).not.toMatch(/heartbeat re-enabled/i);
  });

  it('is a no-op on the schedule step when the mission never had one', async () => {
    missionRow = { id: 'm-1', criteriaEscalatedAt: new Date(), scheduleId: null };

    const result = await resolveCriteriaEscalation('m-1', 'waived', systemActor);

    expect(result.cleared).toBe(true);
    expect(mockScheduleFindFirst).not.toHaveBeenCalled();
    expect(mockScheduleUpdate).not.toHaveBeenCalled();
  });

  it('names the exit reason in the feed note', async () => {
    await resolveCriteriaEscalation('m-1', 'work_filed', systemActor);
    expect(feedEvents[0].body).toMatch(/work was filed against the blocking criteria/i);
  });
});

describe('escalateCriteriaFailure', () => {
  const baseInput = {
    missionId: 'm-1',
    fingerprint: 'fail|c0=fail',
    note: { type: 'question' as const, status: 'open' as const, title: 'Blocked', body: 'body text' },
    scheduleId: 'sched-1',
  };

  beforeEach(() => {
    missionUpdateSetData = null;
    missionUpdateReturning = [{ id: 'm-1' }];
    insertedNotes = [];
    scheduleUpdateSetData = null;
    mockMissionsUpdate.mockClear();
    mockNotesInsert.mockClear();
    mockScheduleUpdate.mockClear();
  });

  it('stamps criteriaEscalatedAt + the fingerprint, files the note, and stands the schedule down — one notification', async () => {
    const result = await escalateCriteriaFailure(baseInput);

    expect(result.escalated).toBe(true);
    expect(missionUpdateSetData.criteriaEscalatedAt).toBeInstanceOf(Date);
    expect(missionUpdateSetData.criteriaRearmFingerprint).toBe('fail|c0=fail');
    expect(insertedNotes).toHaveLength(1);
    expect(insertedNotes[0]).toMatchObject({
      missionId: 'm-1',
      type: 'question',
      status: 'open',
      title: 'Blocked',
      body: 'body text',
    });
    expect(scheduleUpdateSetData.enabled).toBe(false);
    expect(scheduleUpdateSetData.lastDeferralReason).toBe('criteria_escalated');
  });

  it('does not touch a schedule when none is given', async () => {
    await escalateCriteriaFailure({ ...baseInput, scheduleId: null });
    expect(mockScheduleUpdate).not.toHaveBeenCalled();
  });

  it('does not re-notify when the atomic claim is not won — repeated identical verdicts do not re-notify', async () => {
    // Empty RETURNING simulates the WHERE clause excluding the row: already
    // escalated with this exact fingerprint.
    missionUpdateReturning = [];

    const result = await escalateCriteriaFailure(baseInput);

    expect(result.escalated).toBe(false);
    expect(insertedNotes).toHaveLength(0);
    expect(mockScheduleUpdate).not.toHaveBeenCalled();
  });

  it('attributes the note to the given actor', async () => {
    await escalateCriteriaFailure({
      ...baseInput,
      scheduleId: null,
      actor: { kind: 'user', id: 'u-1', label: 'alice' },
    });

    expect(insertedNotes[0].authorType).toBe('user');
    expect(insertedNotes[0].actorLabel).toBe('alice');
  });

  it('defaults the note author to system when no actor is given', async () => {
    await escalateCriteriaFailure({ ...baseInput, scheduleId: null });

    expect(insertedNotes[0].authorType).toBe('system');
    expect(insertedNotes[0].actorLabel).toBeNull();
  });
});
