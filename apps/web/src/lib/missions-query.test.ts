import { describe, it, expect } from 'bun:test';
import {
  adaptFlightStripInputs,
  buildActiveMissionsQueryArgs,
  MISSION_TASK_BASE_COLUMNS,
  MISSION_TASK_RESULT_SUMMARY_EXTRAS,
  decodeCompletedCursor,
  encodeCompletedCursor,
  paginateCompletedMissions,
} from './missions-query';

// The Plan page's query: the live flight-strip fields, and no task `result`
// for any caller (spec 3ef37387 R-11).
describe('mission query shapes', () => {
  it('the active-missions query carries roleSlug/exitCause — Rule A-1/A-2 needs them live', () => {
    const args = buildActiveMissionsQueryArgs(undefined);

    expect((args.columns as Record<string, unknown>).flightStripCache).toBeUndefined();
    expect(args.with.tasks.columns.roleSlug).toBe(true);
    expect(args.with.tasks.with.workers.columns.exitCause).toBe(true);
  });

  it('the active query carries the list card facts: the parked question and the schedule run count', () => {
    const args = buildActiveMissionsQueryArgs(undefined);
    expect(args.with.tasks.with.workers.columns.waitingFor).toBe(true);
    expect(args.with.schedule.columns.totalRuns).toBe(true);
  });

  it('reads workers latest-first, so the live attempt is inside the limit', () => {
    const cols = { startedAt: 'startedAt', updatedAt: 'updatedAt' };
    const ops = { desc: (c: string) => `${c} desc` };
    const w = buildActiveMissionsQueryArgs(undefined).with.tasks.with.workers as any;
    expect(w.limit).toBe(5);
    expect(w.orderBy(cols, ops)).toEqual(['startedAt desc', 'updatedAt desc']);
  });

  it('no shared shape selects a task\'s whole result; a card reads only its summary', () => {
    expect('result' in MISSION_TASK_BASE_COLUMNS).toBe(false);
    expect('result' in buildActiveMissionsQueryArgs(undefined).with.tasks.columns).toBe(false);
    expect(Object.keys(MISSION_TASK_RESULT_SUMMARY_EXTRAS)).toEqual(['result']);
  });
});

// AC-14: bounded result set + cursor for a workspace with more completed
// missions than fit in one page.
describe('AC-14: completed-missions pagination', () => {
  function row(id: string, completedAt: string) {
    return { id, completedAt };
  }

  it('returns all rows with no cursor when under one page', () => {
    const rows = [row('a', '2026-01-03T00:00:00Z'), row('b', '2026-01-02T00:00:00Z')];
    const { items, nextCursor } = paginateCompletedMissions(rows, 5);
    expect(items).toHaveLength(2);
    expect(nextCursor).toBeNull();
  });

  it('trims to pageSize and returns a cursor when more rows exist', () => {
    const rows = Array.from({ length: 5 }, (_, i) =>
      row(`m${i}`, new Date(2026, 0, 10 - i).toISOString()),
    );
    const { items, nextCursor } = paginateCompletedMissions(rows, 3);
    expect(items).toHaveLength(3);
    expect(items.map(r => r.id)).toEqual(['m0', 'm1', 'm2']);
    expect(nextCursor).not.toBeNull();
  });

  it('cursor round-trips through encode/decode', () => {
    const cursor = { completedAt: '2026-01-05T00:00:00.000Z', id: 'm2' };
    const decoded = decodeCompletedCursor(encodeCompletedCursor(cursor));
    expect(decoded).toEqual(cursor);
  });

  it('a malformed cursor decodes to null (first page) instead of throwing', () => {
    expect(decodeCompletedCursor('not-valid-base64url-json')).toBeNull();
    expect(decodeCompletedCursor(undefined)).toBeNull();
    expect(decodeCompletedCursor(null)).toBeNull();
  });

});

describe('adaptFlightStripInputs', () => {
  it('flattens nested tasks->workers and stamps taskId from the parent', () => {
    const { tasks, workers } = adaptFlightStripInputs([
      {
        id: 't1', status: 'completed', taskClass: 'work', roleSlug: 'builder', kind: 'engineering', title: 'Do X',
        workers: [{ id: 'w1', status: 'completed', startedAt: '2026-01-01T00:00:00Z', completedAt: '2026-01-01T01:00:00Z', updatedAt: null, exitCause: null }],
      },
      { id: 't2', status: 'pending', taskClass: 'work', roleSlug: null, kind: null, title: 'Do Y', workers: [] },
    ]);

    expect(tasks).toEqual([
      { id: 't1', status: 'completed', taskClass: 'work', roleSlug: 'builder', kind: 'engineering', title: 'Do X' },
      { id: 't2', status: 'pending', taskClass: 'work', roleSlug: null, kind: null, title: 'Do Y' },
    ]);
    expect(workers).toEqual([
      { id: 'w1', taskId: 't1', status: 'completed', startedAt: '2026-01-01T00:00:00Z', completedAt: '2026-01-01T01:00:00Z', updatedAt: null, exitCause: null },
    ]);
  });

  it('handles a task with no workers array at all', () => {
    const { tasks, workers } = adaptFlightStripInputs([{ id: 't1', status: 'pending', taskClass: null, roleSlug: null, kind: null, title: null }]);
    expect(tasks).toHaveLength(1);
    expect(workers).toEqual([]);
  });
});
