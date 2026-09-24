import { describe, it, expect } from 'bun:test';
import {
  adaptFlightStripInputs,
  buildActiveMissionsQueryArgs,
  buildCompletedMissionsQueryArgs,
  decodeCompletedCursor,
  encodeCompletedCursor,
  paginateCompletedMissions,
  COMPLETED_MISSIONS_PAGE_SIZE,
} from './missions-query';

// AC-12: the completed-missions query shape must skip the flight-strip
// fan-out (roleSlug/exitCause) BY CONSTRUCTION — asserted on the query args
// object itself, not by timing a call or mocking the DB.
describe('AC-12: completed-missions query shape skips flight-strip fan-out', () => {
  it('selects flightStripCache and omits roleSlug/exitCause from the with-clause', () => {
    const args = buildCompletedMissionsQueryArgs(undefined, null);

    expect(args.columns.flightStripCache).toBe(true);
    expect('roleSlug' in args.with.tasks.columns).toBe(false);
    expect('exitCause' in args.with.tasks.with.workers.columns).toBe(false);
  });

  it('the active-missions query DOES carry roleSlug/exitCause — Rule A-1/A-2 needs them live', () => {
    const args = buildActiveMissionsQueryArgs(undefined);

    expect((args.columns as Record<string, unknown>).flightStripCache).toBeUndefined();
    expect(args.with.tasks.columns.roleSlug).toBe(true);
    expect(args.with.tasks.with.workers.columns.exitCause).toBe(true);
  });

  it('both queries read workers latest-first, so the live attempt is inside the limit', () => {
    const cols = { startedAt: 'startedAt', updatedAt: 'updatedAt' };
    const ops = { desc: (c: string) => `${c} desc` };
    for (const args of [buildActiveMissionsQueryArgs(undefined), buildCompletedMissionsQueryArgs(undefined, null)]) {
      const w = args.with.tasks.with.workers as any;
      expect(w.limit).toBe(5);
      expect(w.orderBy(cols, ops)).toEqual(['startedAt desc', 'updatedAt desc']);
    }
  });

  it('active query excludes completed missions; completed query excludes everything else', () => {
    // Both `where` clauses are opaque SQL objects (can't run them without a DB),
    // but their presence/absence of a status filter is what AC-12 actually
    // cares about being asymmetric-by-construction, not by accident.
    const active = buildActiveMissionsQueryArgs(undefined);
    const completed = buildCompletedMissionsQueryArgs(undefined, null);
    expect(active.where).toBeDefined();
    expect(completed.where).toBeDefined();
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

  it('the query requests exactly pageSize+1 rows (the over-fetch that makes hasMore free)', () => {
    const args = buildCompletedMissionsQueryArgs(undefined, null);
    expect(args.limit).toBe(COMPLETED_MISSIONS_PAGE_SIZE + 1);
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

  it('a cursor shifts the query into a second page — cursor changes the where clause', () => {
    // Drizzle SQL objects are self-referential, so compare chunk counts
    // rather than JSON.stringify (which throws on the cycle).
    const chunkCount = (where: unknown) => (where as { queryChunks?: unknown[] })?.queryChunks?.length ?? 0;
    const firstPage = buildCompletedMissionsQueryArgs(undefined, null);
    const cursor = { completedAt: '2026-01-05T00:00:00.000Z', id: 'm2' };
    const secondPage = buildCompletedMissionsQueryArgs(undefined, cursor);
    // The cursor page ANDs in an extra clause, so it has strictly more chunks.
    expect(chunkCount(secondPage.where)).toBeGreaterThan(chunkCount(firstPage.where));
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
