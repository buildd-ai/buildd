import { describe, expect, it, mock, beforeEach } from 'bun:test';
import type { ArchiveCandidate } from './mission-archive';

const NOW = new Date('2026-07-05T12:00:00Z');
const HOURS = 60 * 60 * 1000;

let findManyResult: any[] = [];
const mockFindMany = mock(() => Promise.resolve(findManyResult));
const deleteWhereCalls: any[] = [];
const updateSetCalls: any[] = [];
const updateWhereCalls: any[] = [];

mock.module('@buildd/core/db', () => ({
  db: {
    query: { missions: { findMany: mockFindMany } },
    delete: mock(() => ({
      where: mock((cond: any) => {
        deleteWhereCalls.push(cond);
        return Promise.resolve();
      }),
    })),
    update: mock(() => ({
      set: mock((vals: any) => {
        updateSetCalls.push(vals);
        return {
          where: mock((cond: any) => {
            updateWhereCalls.push(cond);
            return Promise.resolve();
          }),
        };
      }),
    })),
  },
}));

const realDrizzleOrm: any = await import('drizzle-orm');
mock.module('drizzle-orm', () => ({
  ...realDrizzleOrm,
  eq: (field: any, value: any) => ({ type: 'eq', field, value }),
  inArray: (field: any, values: any) => ({ type: 'inArray', field, values }),
}));

const { selectMissionsToArchive, archiveStaleDoneMissions } = await import('./mission-archive');

function candidate(overrides: Partial<ArchiveCandidate> = {}): ArchiveCandidate {
  return {
    id: 'm1',
    status: 'active',
    updatedAt: new Date(NOW.getTime() - 30 * HOURS),
    scheduleEnabled: null,
    tasks: [
      { status: 'completed', updatedAt: new Date(NOW.getTime() - 30 * HOURS) },
      { status: 'completed', updatedAt: new Date(NOW.getTime() - 26 * HOURS) },
    ],
    ...overrides,
  };
}

describe('selectMissionsToArchive', () => {
  it('archives an active, all-tasks-completed mission quiet for >24h', () => {
    expect(selectMissionsToArchive([candidate()], NOW)).toEqual(['m1']);
  });

  it('skips missions with recent task activity (<24h)', () => {
    const c = candidate({
      tasks: [
        { status: 'completed', updatedAt: new Date(NOW.getTime() - 30 * HOURS) },
        { status: 'completed', updatedAt: new Date(NOW.getTime() - 2 * HOURS) },
      ],
    });
    expect(selectMissionsToArchive([c], NOW)).toEqual([]);
  });

  it('skips missions whose own row was touched recently', () => {
    const c = candidate({ updatedAt: new Date(NOW.getTime() - 1 * HOURS) });
    expect(selectMissionsToArchive([c], NOW)).toEqual([]);
  });

  it('skips missions with any non-completed task (failed/pending/running)', () => {
    for (const status of ['failed', 'pending', 'running']) {
      const c = candidate({
        tasks: [
          { status: 'completed', updatedAt: new Date(NOW.getTime() - 30 * HOURS) },
          { status, updatedAt: new Date(NOW.getTime() - 30 * HOURS) },
        ],
      });
      expect(selectMissionsToArchive([c], NOW)).toEqual([]);
    }
  });

  it('skips missions with no tasks', () => {
    expect(selectMissionsToArchive([candidate({ tasks: [] })], NOW)).toEqual([]);
  });

  it('skips paused and completed missions (deliberate states)', () => {
    expect(selectMissionsToArchive([candidate({ status: 'paused' })], NOW)).toEqual([]);
    expect(selectMissionsToArchive([candidate({ status: 'completed' })], NOW)).toEqual([]);
  });

  it('skips missions with an enabled schedule (they will run again)', () => {
    expect(selectMissionsToArchive([candidate({ scheduleEnabled: true })], NOW)).toEqual([]);
    // Disabled schedule does not block archiving
    expect(selectMissionsToArchive([candidate({ scheduleEnabled: false })], NOW)).toEqual(['m1']);
  });

  // ── Awaiting verification is an open question, not a done mission ──────────
  //
  // M2 was archived a day after it closed. Archiving clears a mission off Home,
  // which is precisely how a mission with four never-evaluated criteria stops
  // being anybody's problem. A stated criterion without a passing verdict keeps
  // the mission visible.

  it('skips a mission whose goal criteria were never evaluated', () => {
    const c = candidate({ criteriaCount: 4, criteriaOverall: null });
    expect(selectMissionsToArchive([c], NOW)).toEqual([]);
  });

  it('skips a mission whose goal criteria are unverified or failing', () => {
    for (const overall of ['UNVERIFIED', 'fail', 'PENDING', 'NOT_EVALUATED']) {
      const c = candidate({ criteriaCount: 2, criteriaOverall: overall });
      expect(selectMissionsToArchive([c], NOW)).toEqual([]);
    }
  });

  it('archives when the criteria pass', () => {
    const c = candidate({ criteriaCount: 2, criteriaOverall: 'pass' });
    expect(selectMissionsToArchive([c], NOW)).toEqual(['m1']);
  });

  it('archives a mission that states no criteria (regression guard)', () => {
    expect(selectMissionsToArchive([candidate({ criteriaCount: 0, criteriaOverall: null })], NOW)).toEqual(['m1']);
  });
});

function dbRow(overrides: Record<string, any> = {}) {
  return {
    id: 'm1',
    status: 'active',
    updatedAt: new Date(NOW.getTime() - 30 * HOURS),
    scheduleId: 'sched-1',
    goalCriteria: [],
    goalCriteriaState: null,
    schedule: { enabled: false },
    tasks: [{ status: 'completed', updatedAt: new Date(NOW.getTime() - 30 * HOURS) }],
    ...overrides,
  };
}

// ── Regression: archiveStaleDoneMissions must not orphan the schedule row ──
//
// This raw-db.update path bypassed the PATCH route's "explicit terminal status
// deletes the schedule" fix (apps/web/src/app/api/missions/[id]/route.ts) because
// it never routed through it — it only ever writes status='archived' directly.
// Its own selector only ever picks missions whose schedule is already disabled,
// so the leftover row sat there forever: disabled, never deleted.
describe('archiveStaleDoneMissions', () => {
  beforeEach(() => {
    findManyResult = [];
    deleteWhereCalls.length = 0;
    updateSetCalls.length = 0;
    updateWhereCalls.length = 0;
  });

  it('deletes the task_schedules row and nulls scheduleId for a mission it archives', async () => {
    findManyResult = [dbRow()];

    const ids = await archiveStaleDoneMissions(NOW);

    expect(ids).toEqual(['m1']);
    expect(deleteWhereCalls).toHaveLength(1);
    expect(deleteWhereCalls[0]).toMatchObject({ type: 'inArray', values: ['sched-1'] });
    expect(updateSetCalls[0]).toMatchObject({ status: 'archived', scheduleId: null });
  });

  it('does not touch task_schedules when no mission is selected for archiving', async () => {
    findManyResult = [dbRow({ updatedAt: NOW })]; // recent activity -> not stale

    const ids = await archiveStaleDoneMissions(NOW);

    expect(ids).toEqual([]);
    expect(deleteWhereCalls).toEqual([]);
    expect(updateSetCalls).toEqual([]);
  });

  it('skips the schedule delete (but still nulls scheduleId) when the archived mission has none', async () => {
    findManyResult = [dbRow({ scheduleId: null, schedule: null })];

    const ids = await archiveStaleDoneMissions(NOW);

    expect(ids).toEqual(['m1']);
    expect(deleteWhereCalls).toEqual([]);
    expect(updateSetCalls[0]).toMatchObject({ status: 'archived', scheduleId: null });
  });
});
