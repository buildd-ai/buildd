import { describe, expect, it, mock } from 'bun:test';

// Rows by id; the mocked db ignores the where clause, so each lookup reads
// the id the resolver asked for via the `where` object we capture.
const taskRows = new Map<string, Record<string, string | null>>();
const missionRows = new Map<string, { createdByUserId: string | null }>();
const scheduleRows = new Map<string, { createdByUserId: string | null }>();

// eq() from drizzle builds an SQL object; stub it so the id is readable.
mock.module('drizzle-orm', () => ({ eq: (_col: unknown, value: string) => ({ id: value }) }));
mock.module('../db/schema', () => ({ tasks: {}, missions: {}, taskSchedules: {} }));
mock.module('../db', () => ({
  db: {
    query: {
      tasks: { findFirst: async ({ where }: { where: { id: string } }) => taskRows.get(where.id) },
      missions: { findFirst: async ({ where }: { where: { id: string } }) => missionRows.get(where.id) },
      taskSchedules: { findFirst: async ({ where }: { where: { id: string } }) => scheduleRows.get(where.id) },
    },
  },
}));

const { resolveTaskRequesterUserId } = await import('../task-requester');

describe('resolveTaskRequesterUserId', () => {
  it("uses the task's own requester first", async () => {
    missionRows.set('m1', { createdByUserId: 'mission-owner' });
    expect(await resolveTaskRequesterUserId({ createdByUserId: 'u1', missionId: 'm1' })).toBe('u1');
  });

  it('walks up parent tasks to the first one with a requester', async () => {
    taskRows.set('p2', { createdByUserId: null, parentTaskId: 'p1', missionId: null, scheduleId: null });
    taskRows.set('p1', { createdByUserId: 'root-user', parentTaskId: null, missionId: null, scheduleId: null });
    expect(await resolveTaskRequesterUserId({ parentTaskId: 'p2' })).toBe('root-user');
  });

  it('falls back to the mission creator, including a mission found on a parent', async () => {
    taskRows.set('p3', { createdByUserId: null, parentTaskId: null, missionId: 'm2', scheduleId: null });
    missionRows.set('m2', { createdByUserId: 'mission-user' });
    expect(await resolveTaskRequesterUserId({ parentTaskId: 'p3' })).toBe('mission-user');
  });

  it('falls back to the schedule creator', async () => {
    scheduleRows.set('s1', { createdByUserId: 'schedule-user' });
    expect(await resolveTaskRequesterUserId({ scheduleId: 's1' })).toBe('schedule-user');
  });

  it('returns null when no person is behind the task', async () => {
    missionRows.set('m3', { createdByUserId: null });
    expect(await resolveTaskRequesterUserId({ missionId: 'm3' })).toBeNull();
    expect(await resolveTaskRequesterUserId({})).toBeNull();
  });

  it('stops on a parent cycle', async () => {
    taskRows.set('c1', { createdByUserId: null, parentTaskId: 'c2', missionId: null, scheduleId: null });
    taskRows.set('c2', { createdByUserId: null, parentTaskId: 'c1', missionId: null, scheduleId: null });
    expect(await resolveTaskRequesterUserId({ parentTaskId: 'c1' })).toBeNull();
  });
});
