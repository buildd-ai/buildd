import { describe, expect, it } from 'bun:test';
import {
  compareTasksChrono,
  compareWorkersChrono,
  newestFirst,
  newestWhere,
  oldestFirst,
  selectTaskWorkers,
} from './attempt-order';

interface W {
  id: string;
  createdAt: Date;
  status: string;
  updatedAt: Date;
  startedAt: Date | null;
  prUrl: string | null;
  prNumber: number | null;
}

const T0 = new Date('2026-01-01T00:00:00Z');
const T1 = new Date('2026-01-01T00:01:00Z');

function w(id: string, createdAt: Date, over: Partial<W> = {}): W {
  return { id, createdAt, status: 'completed', updatedAt: createdAt, startedAt: createdAt, prUrl: null, prNumber: null, ...over };
}

function permutations<T>(xs: readonly T[]): T[][] {
  if (xs.length <= 1) return [xs.slice()];
  return xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map(p => [x, ...p]));
}

/** Deterministic Fisher-Yates so a failure reproduces. */
function shuffled<T>(xs: readonly T[], seed: number): T[] {
  const out = xs.slice();
  let s = seed;
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const ids = (xs: ReadonlyArray<{ id: string }>) => xs.map(x => x.id);

describe('compareWorkersChrono', () => {
  it('orders by createdAt ascending first', () => {
    expect(ids(oldestFirst([w('a', T1), w('b', T0)], compareWorkersChrono))).toEqual(['b', 'a']);
  });

  it('breaks an equal createdAt by id ascending', () => {
    expect(ids(oldestFirst([w('c', T0), w('a', T0), w('b', T0)], compareWorkersChrono))).toEqual(['a', 'b', 'c']);
  });

  // C-1: three workers sharing one instant sort the same for every input order.
  it('gives one order for every permutation of three tied workers', () => {
    const tied = [w('w-2', T0), w('w-10', T0), w('w-1', T0)];
    const expected = ids(newestFirst(tied, compareWorkersChrono));
    for (const p of permutations(tied)) expect(ids(newestFirst(p, compareWorkersChrono))).toEqual(expected);
    // Lexicographic, not numeric: the tiebreak is the id string.
    expect(expected).toEqual(['w-2', 'w-10', 'w-1']);
  });

  // C-1: nothing a sync can change moves a row.
  it('ignores status, updatedAt and startedAt', () => {
    const base = [w('a', T0), w('b', T0), w('c', T1)];
    const expected = ids(newestFirst(base, compareWorkersChrono));
    const flipped = [
      w('a', T0, { status: 'running', updatedAt: new Date('2027-01-01'), startedAt: null }),
      w('b', T0, { status: 'failed', updatedAt: new Date('2020-01-01') }),
      w('c', T1, { status: 'superseded', startedAt: new Date('2030-01-01') }),
    ];
    expect(ids(newestFirst(flipped, compareWorkersChrono))).toEqual(expected);
  });

  it('accepts epoch ms and ISO strings the same as Dates', () => {
    expect(compareWorkersChrono({ id: 'a', createdAt: T0.getTime() }, { id: 'b', createdAt: T0.toISOString() })).toBeLessThan(0);
    expect(compareWorkersChrono({ id: 'a', createdAt: T1 }, { id: 'b', createdAt: T0.getTime() })).toBeGreaterThan(0);
  });

  it('does not mutate its input', () => {
    const input = [w('b', T0), w('a', T0)];
    newestFirst(input, compareWorkersChrono);
    oldestFirst(input, compareWorkersChrono);
    expect(ids(input)).toEqual(['b', 'a']);
  });
});

describe('compareTasksChrono', () => {
  it('orders tasks by createdAt, then id', () => {
    const tasks = [{ id: 't-b', createdAt: T0 }, { id: 't-c', createdAt: T1 }, { id: 't-a', createdAt: T0 }];
    for (const p of permutations(tasks)) expect(ids(oldestFirst(p, compareTasksChrono))).toEqual(['t-a', 't-b', 't-c']);
  });
});

describe('newestWhere', () => {
  it('returns the newest matching item regardless of input order', () => {
    const xs = [w('a', T0, { status: 'running' }), w('b', T0, { status: 'running' }), w('c', T1)];
    for (const p of permutations(xs)) expect(newestWhere(p, x => x.status === 'running', compareWorkersChrono)?.id).toBe('b');
  });

  it('returns undefined when nothing matches', () => {
    expect(newestWhere([w('a', T0)], () => false, compareWorkersChrono)).toBeUndefined();
  });
});

// C-3: latest / active / PR worker are picked from the order, never from the
// order the database happened to return rows in.
describe('selectTaskWorkers', () => {
  const isLive = (s: string) => s === 'running' || s === 'waiting_input';
  const rows = [
    w('w-a', T0, { status: 'running' }),
    w('w-b', T0, { status: 'waiting_input' }),
    w('w-c', T0, { status: 'completed', prUrl: 'https://example.test/pr/1', prNumber: 1 }),
    w('w-d', T0, { status: 'failed', prUrl: 'https://example.test/pr/1', prNumber: 1 }),
    w('w-0', new Date('2025-12-31T00:00:00Z'), { status: 'running', prUrl: 'https://example.test/pr/1', prNumber: 1 }),
  ];

  it('is identical across shuffled inputs with ties', () => {
    const first = selectTaskWorkers(rows, isLive);
    expect(first.latestWorker?.id).toBe('w-d');
    expect(first.activeWorker?.id).toBe('w-b');
    expect(first.prWorker?.id).toBe('w-d');
    expect(ids(first.ordered)).toEqual(['w-d', 'w-c', 'w-b', 'w-a', 'w-0']);
    for (let seed = 1; seed <= 100; seed++) {
      const s = selectTaskWorkers(shuffled(rows, seed), isLive);
      expect(s.latestWorker?.id).toBe(first.latestWorker!.id);
      expect(s.activeWorker?.id).toBe(first.activeWorker!.id);
      expect(s.prWorker?.id).toBe(first.prWorker!.id);
      expect(ids(s.ordered)).toEqual(ids(first.ordered));
    }
  });

  it('a status flip changes no selection but the one whose predicate it flips', () => {
    const flipped = rows.map(r => (r.id === 'w-a' ? { ...r, status: 'completed', updatedAt: new Date('2027-01-01') } : r));
    const s = selectTaskWorkers(flipped, isLive);
    expect(ids(s.ordered)).toEqual(['w-d', 'w-c', 'w-b', 'w-a', 'w-0']);
    expect(s.latestWorker?.id).toBe('w-d');
    expect(s.activeWorker?.id).toBe('w-b');
  });

  it('is empty for no workers', () => {
    const s = selectTaskWorkers([] as W[], isLive);
    expect(s.ordered).toEqual([]);
    expect(s.latestWorker).toBeUndefined();
    expect(s.activeWorker).toBeUndefined();
    expect(s.prWorker).toBeUndefined();
  });
});
