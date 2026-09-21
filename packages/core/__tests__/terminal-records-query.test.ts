/**
 * `getOrphanRate` — the metric this whole ledger exists to make measurable.
 */
import { describe, it, expect, beforeEach, mock } from 'bun:test';

let queryResult: Array<{ startedCount: number; recordedCount: number }> = [];

mock.module('../db/client', () => ({
  db: {
    select: () => ({
      from: () => ({
        leftJoin: () => ({
          where: async () => queryResult,
        }),
      }),
    }),
  },
}));

const { getOrphanRate } = await import('../terminal-records-query');

beforeEach(() => {
  queryResult = [];
});

describe('getOrphanRate', () => {
  it('is unavailable (no_scope), not zero, when nothing started in the window', async () => {
    queryResult = [{ startedCount: 0, recordedCount: 0 }];
    const metric = await getOrphanRate(new Date('2026-01-01'), new Date('2026-01-02'));
    expect(metric).toEqual({ kind: 'unavailable', reason: 'no_scope' });
  });

  it('computes orphanRate from started vs recorded counts', async () => {
    queryResult = [{ startedCount: 100, recordedCount: 77 }];
    const metric = await getOrphanRate(new Date('2026-01-01'), new Date('2026-01-02'));
    expect(metric.kind).toBe('value');
    if (metric.kind !== 'value') throw new Error('unreachable');
    expect(metric.value.startedCount).toBe(100);
    expect(metric.value.recordedCount).toBe(77);
    expect(metric.value.orphanCount).toBe(23);
    expect(metric.value.orphanRate).toBeCloseTo(0.23);
  });

  it('reports zero orphans when every started session has a terminal record', async () => {
    queryResult = [{ startedCount: 50, recordedCount: 50 }];
    const metric = await getOrphanRate(new Date('2026-01-01'), new Date('2026-01-02'));
    if (metric.kind !== 'value') throw new Error('unreachable');
    expect(metric.value.orphanCount).toBe(0);
    expect(metric.value.orphanRate).toBe(0);
  });
});
