import { describe, it, expect, mock, beforeEach } from 'bun:test';

/**
 * `loadSchedulingMetricsInput` (§6 scheduling metrics loader,
 * knowledge-base: buildd/design/jev-scheduling.md §6). The db client is
 * stubbed with a table-free dispatch keyed on the exact set of selected
 * column names — every query in the loader selects a distinct column set, so
 * this tells queries apart without needing to parse SQL or track call order.
 */

const responses = new Map<string, unknown[]>();
function respond(fields: string[], rows: unknown[]) {
  responses.set([...fields].sort().join(','), rows);
}

function chain(result: Promise<unknown[]>) {
  const obj: Record<string, unknown> = {
    where: () => obj,
    limit: () => obj,
    innerJoin: () => obj,
    then: (res: (v: unknown[]) => unknown, rej: (e: unknown) => unknown) => result.then(res, rej),
  };
  return obj;
}

mock.module('../db/client', () => ({
  db: {
    select: (fields: Record<string, unknown>) => ({
      from: () => {
        const key = Object.keys(fields).sort().join(',');
        return chain(Promise.resolve(responses.get(key) ?? []));
      },
    }),
  },
}));

const src = await import('../orchestration-readout-source');

const WS = 'ws-1';
const WINDOW = { workspaceId: WS, since: new Date('2026-09-01T00:00:00Z'), until: new Date('2026-10-01T00:00:00Z') };

beforeEach(() => {
  responses.clear();
});

describe('loadSchedulingMetricsInput', () => {
  it('buckets claim-loop deferrals (primary reasons + codex_single_flight) and stranded rows by ISO week', async () => {
    respond(['occurredAt', 'outcome', 'reason'], [
      { occurredAt: new Date('2026-09-02T10:00:00Z'), outcome: 'deferred', reason: 'path_overlap' },
      { occurredAt: new Date('2026-09-02T11:00:00Z'), outcome: 'deferred', reason: 'advisory_manifest' },
      { occurredAt: new Date('2026-09-02T12:00:00Z'), outcome: 'deferred', reason: 'ordered_behind' },
      { occurredAt: new Date('2026-09-02T13:00:00Z'), outcome: 'deferred', reason: 'codex_single_flight' },
      { occurredAt: new Date('2026-09-02T14:00:00Z'), outcome: 'deferred', reason: 'workspace_cap' }, // not a primary reason: ignored
      { occurredAt: new Date('2026-09-03T00:00:00Z'), outcome: 'stranded', reason: 'path_overlap' },
    ]);

    const rows = await src.loadSchedulingMetricsInput(WINDOW);
    expect(rows).toHaveLength(1);
    const w = rows[0];
    expect(w.workspaceId).toBe(WS);
    expect(w.deferrals).toEqual({ path_overlap: 1, advisory_manifest: 1, ordered_behind: 1, codex_single_flight: 1 });
    expect(w.strandedCount).toBe(1);
  });

  it('reads claim_plan samples (mode, backend, agree, candidateCount, actual picks, capacity), weighted by the coalesced repeat count', async () => {
    respond(['occurredAt', 'detail'], [
      {
        occurredAt: new Date('2026-09-02T10:00:00Z'),
        detail: { mode: 'apply', backend: 'codex', agree: false, candidateCount: 3, actual: ['a'], capacity: 2, count: 2 },
      },
      {
        occurredAt: new Date('2026-09-02T11:00:00Z'),
        detail: { mode: 'record', backend: 'claude', agree: true, candidateCount: 1, actual: ['a'], capacity: 1 },
      },
    ]);

    const rows = await src.loadSchedulingMetricsInput(WINDOW);
    expect(rows).toHaveLength(1);
    const w = rows[0];
    // The apply sample is weighted by its coalesced count (2): two identical samples.
    expect(w.claimPlans.filter(p => p.backend === 'codex')).toHaveLength(2);
    expect(w.claimPlans.find(p => p.backend === 'codex')).toMatchObject({ mode: 'apply', agree: false, candidateCount: 3, pickedCount: 1, capacity: 2 });
    expect(w.claimPlans.find(p => p.backend === 'claude')).toMatchObject({ mode: 'record', agree: true, pickedCount: 1, capacity: 1 });
    // A week with no deferral rows but a plan row is promoted off 'off'.
    expect(w.mode).toBe('apply');
  });

  it('counts silent completions', async () => {
    respond(['occurredAt'], [{ occurredAt: new Date('2026-09-05T00:00:00Z') }, { occurredAt: new Date('2026-09-06T00:00:00Z') }]);
    const rows = await src.loadSchedulingMetricsInput(WINDOW);
    expect(rows).toHaveLength(1);
    expect(rows[0].silentCompletionCount).toBe(2);
  });

  it('flags a supersession cancel as reverted when the task is no longer cancelled', async () => {
    respond(['occurredAt', 'taskId'], [
      { occurredAt: new Date('2026-09-05T00:00:00Z'), taskId: 't-reverted' },
      { occurredAt: new Date('2026-09-05T00:00:00Z'), taskId: 't-stayed-cancelled' },
    ]);
    respond(['id', 'status'], [
      { id: 't-reverted', status: 'pending' },
      { id: 't-stayed-cancelled', status: 'cancelled' },
    ]);

    const rows = await src.loadSchedulingMetricsInput(WINDOW);
    expect(rows).toHaveLength(1);
    expect(rows[0].supersessionCancelCount).toBe(2);
    expect(rows[0].supersessionRevertedCount).toBe(1);
  });

  it('counts claimed and conflict tasks by their own week, and merge latency/merged-PR count by merge week', async () => {
    respond(['claimedAt'], [{ claimedAt: new Date('2026-09-02T00:00:00Z') }, { claimedAt: new Date('2026-09-09T00:00:00Z') }]);
    respond(['createdAt'], [{ createdAt: new Date('2026-09-02T00:00:00Z') }]);
    respond(['mergedAt', 'taskCreatedAt'], [
      { mergedAt: new Date('2026-09-02T12:00:00Z'), taskCreatedAt: new Date('2026-09-01T12:00:00Z') }, // 24h
    ]);

    const rows = await src.loadSchedulingMetricsInput(WINDOW);
    expect(rows.reduce((a, r) => a + r.claimedTaskCount, 0)).toBe(2);
    expect(rows.reduce((a, r) => a + r.conflictTaskCount, 0)).toBe(1);
    const mergeWeek = rows.find(r => r.mergedPrCount > 0)!;
    expect(mergeWeek.mergedPrCount).toBe(1);
    expect(mergeWeek.mergeLatenciesMs).toEqual([24 * 60 * 60 * 1000]);
  });

  it('samples co-running worker pairs and flags an overlap in touched paths as unsafe', async () => {
    respond(['id', 'startedAt', 'completedAt'], [
      { id: 'w1', startedAt: new Date('2026-09-02T10:00:00Z'), completedAt: new Date('2026-09-02T11:00:00Z') },
      { id: 'w2', startedAt: new Date('2026-09-02T10:30:00Z'), completedAt: new Date('2026-09-02T11:30:00Z') }, // overlaps w1
      { id: 'w3', startedAt: new Date('2026-09-02T12:00:00Z'), completedAt: new Date('2026-09-02T13:00:00Z') }, // no overlap
    ]);
    respond(['workerId', 'touchedPaths'], [
      { workerId: 'w1', touchedPaths: ['a/b.ts'] },
      { workerId: 'w2', touchedPaths: ['a/b.ts'] }, // overlaps w1
      { workerId: 'w3', touchedPaths: ['c/d.ts'] },
    ]);

    const rows = await src.loadSchedulingMetricsInput(WINDOW);
    expect(rows).toHaveLength(1);
    expect(rows[0].coScheduleSampleCount).toBe(1);
    expect(rows[0].unsafeCoScheduleCount).toBe(1);
  });

  it('returns no weeks at all when nothing happened in the window', async () => {
    const rows = await src.loadSchedulingMetricsInput(WINDOW);
    expect(rows).toEqual([]);
  });
});
