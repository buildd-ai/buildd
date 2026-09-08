import { describe, it, expect, beforeEach, mock } from 'bun:test';

let missionRow: any = null;
let scheduleRow: any = null;

let missionUpdateSetData: any = null;
let noteUpdateSetData: any = null;
let scheduleUpdateSetData: any = null;

const mockMissionsFindFirst = mock(() => Promise.resolve(missionRow));
const mockScheduleFindFirst = mock(() => Promise.resolve(scheduleRow));

const mockMissionsUpdate = mock(() => ({
  set: mock((data: any) => {
    missionUpdateSetData = data;
    return { where: mock(() => Promise.resolve()) };
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

// No `insert` is provided here on purpose: resolveCriteriaEscalation must
// never file a task, so a stray db.insert() call fails the test suite loudly
// (TypeError) instead of silently succeeding.
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
}));

let feedEvents: any[] = [];
const mockPostMissionFeedEvent = mock((opts: any) => {
  feedEvents.push(opts);
  return Promise.resolve();
});
mock.module('@/lib/mission-feed', () => ({
  postMissionFeedEvent: mockPostMissionFeedEvent,
}));

import { resolveCriteriaEscalation } from './criteria-escalation';

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
