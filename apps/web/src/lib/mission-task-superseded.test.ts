import { describe, it, expect, beforeEach, mock } from 'bun:test';

let workerRows: Array<{ prNumber: number | null; mergedAt: Date | null }> = [];
let siblingTaskRows: Array<{
  id: string;
  title: string;
  createdAt: Date;
  workers: Array<{ prNumber: number | null; mergedAt: Date | null }>;
}> = [];

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workers: {
        findMany: mock(() => Promise.resolve(workerRows)),
      },
      tasks: {
        findMany: mock(() => Promise.resolve(siblingTaskRows)),
      },
    },
  },
}));

mock.module('@buildd/core/db/schema', () => ({
  tasks: 'tasks',
  workers: 'workers',
}));

mock.module('drizzle-orm', () => ({
  and: (...args: any[]) => ({ args, type: 'and' }),
  eq: (field: any, value: any) => ({ field, value, type: 'eq' }),
  inArray: (field: any, values: any[]) => ({ field, values, type: 'inArray' }),
  isNotNull: (field: any) => ({ field, type: 'isNotNull' }),
}));

import { computeSupersededFailedTasks } from './mission-task-superseded';

describe('computeSupersededFailedTasks', () => {
  beforeEach(() => {
    workerRows = [];
    siblingTaskRows = [];
  });

  it('returns empty map when there are no failed tasks', async () => {
    const result = await computeSupersededFailedTasks('m-1', []);
    expect(result.size).toBe(0);
  });

  it('marks a task superseded when its subjectPrNumber merged', async () => {
    workerRows = [{ prNumber: 2456, mergedAt: new Date() }];
    const result = await computeSupersededFailedTasks('m-1', [
      { id: 't-1', title: 'Rescue task', subjectPrNumber: 2456, createdAt: new Date() },
    ]);
    expect(result.get('t-1')).toEqual({ taskId: 't-1', prNumber: 2456, supersedingTaskId: null });
  });

  it('does not mark superseded when the subject PR has not merged', async () => {
    workerRows = []; // no merged worker for prNumber 2456
    const result = await computeSupersededFailedTasks('m-1', [
      { id: 't-1', title: 'Rescue task', subjectPrNumber: 2456, createdAt: new Date() },
    ]);
    expect(result.has('t-1')).toBe(false);
  });

  it('marks a task superseded via a title-equivalent sibling that completed with a merged PR after it', async () => {
    const failedCreatedAt = new Date('2026-09-17T08:00:00Z');
    const siblingCreatedAt = new Date('2026-09-17T09:00:00Z');
    siblingTaskRows = [
      {
        id: 't-2',
        title: '[reviewer] PR #2456: BUILD',
        createdAt: siblingCreatedAt,
        workers: [{ prNumber: 2456, mergedAt: new Date('2026-09-17T10:00:00Z') }],
      },
    ];
    const result = await computeSupersededFailedTasks('m-1', [
      { id: 't-1', title: '[reviewer] PR #2456: BUILD', subjectPrNumber: null, createdAt: failedCreatedAt },
    ]);
    expect(result.get('t-1')).toEqual({ taskId: 't-1', prNumber: 2456, supersedingTaskId: 't-2' });
  });

  it('does not match a sibling created before the failed task', async () => {
    const failedCreatedAt = new Date('2026-09-17T09:00:00Z');
    const siblingCreatedAt = new Date('2026-09-17T08:00:00Z'); // earlier
    siblingTaskRows = [
      {
        id: 't-2',
        title: '[reviewer] PR #2456: BUILD',
        createdAt: siblingCreatedAt,
        workers: [{ prNumber: 2456, mergedAt: new Date('2026-09-17T10:00:00Z') }],
      },
    ];
    const result = await computeSupersededFailedTasks('m-1', [
      { id: 't-1', title: '[reviewer] PR #2456: BUILD', subjectPrNumber: null, createdAt: failedCreatedAt },
    ]);
    expect(result.has('t-1')).toBe(false);
  });

  it('does not match a sibling with an unmerged PR', async () => {
    siblingTaskRows = [
      {
        id: 't-2',
        title: '[reviewer] PR #2456: BUILD',
        createdAt: new Date('2026-09-17T09:00:00Z'),
        workers: [{ prNumber: 2456, mergedAt: null }],
      },
    ];
    const result = await computeSupersededFailedTasks('m-1', [
      { id: 't-1', title: '[reviewer] PR #2456: BUILD', subjectPrNumber: null, createdAt: new Date('2026-09-17T08:00:00Z') },
    ]);
    expect(result.has('t-1')).toBe(false);
  });

  it('leaves an unmatched task out of the result entirely', async () => {
    const result = await computeSupersededFailedTasks('m-1', [
      { id: 't-1', title: 'Unrelated failure', subjectPrNumber: null, createdAt: new Date() },
    ]);
    expect(result.has('t-1')).toBe(false);
  });
});
