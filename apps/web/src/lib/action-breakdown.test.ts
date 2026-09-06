import { describe, it, expect } from 'bun:test';
import { buildActionBreakdownPanel } from './usage-drilldown';

const SINCE = '2026-09-03';
const AFTER = new Date('2026-09-05T00:00:00Z');   // window opens after capture
const BEFORE = new Date('2026-08-10T00:00:00Z');  // window opens before capture

const rows = (...actions: string[]) =>
  actions.map((action, i) => ({ workerId: `w${i % 3}`, action }));

describe('buildActionBreakdownPanel', () => {
  it('counts actions and ranks them most frequent first', () => {
    const p = buildActionBreakdownPanel({
      rows: rows('claim_task', 'update_progress', 'update_progress', 'create_pr', 'update_progress'),
      workers: 10, windowStart: AFTER, capturedSince: SINCE, rowLimit: 5000,
    });
    expect(p.actions.map(a => a.action)).toEqual(['update_progress', 'claim_task', 'create_pr']);
    expect(p.actions[0]!.calls).toBe(3);
    expect(p.totalCalls).toBe(5);
    expect(p.actions[0]!.share).toBeCloseTo(60, 5);
  });

  it('breaks frequency ties by name, so the order is stable across reloads', () => {
    const p = buildActionBreakdownPanel({
      rows: rows('zeta', 'alpha'), workers: 1, windowStart: AFTER, capturedSince: SINCE, rowLimit: 5000,
    });
    expect(p.actions.map(a => a.action)).toEqual(['alpha', 'zeta']);
  });

  it('reports the coverage denominator, not just the numerator', () => {
    // workersWithEvents/workers is the third coverage class: there is no
    // derived fallback, only "captured" or "not yet".
    const p = buildActionBreakdownPanel({
      rows: rows('a', 'b', 'c', 'd'), workers: 25, windowStart: AFTER, capturedSince: SINCE, rowLimit: 5000,
    });
    expect(p.workersWithEvents).toBe(3); // three distinct workerIds in the fixture
    expect(p.workers).toBe(25);
  });

  it('flags a window that opens before capture began', () => {
    // The whole point of the caveat: a low count in such a window means "not
    // yet recorded", not "quiet". A 30d window today still predates capture.
    expect(buildActionBreakdownPanel({
      rows: rows('a'), workers: 5, windowStart: BEFORE, capturedSince: SINCE, rowLimit: 5000,
    }).windowPredatesCapture).toBe(true);
    expect(buildActionBreakdownPanel({
      rows: rows('a'), workers: 5, windowStart: AFTER, capturedSince: SINCE, rowLimit: 5000,
    }).windowPredatesCapture).toBe(false);
  });

  it('flags the window independently of whether any events were found', () => {
    // The caveat is a property of the window, not of the result set — an empty
    // pre-capture window is exactly the case that must not read as zero.
    const p = buildActionBreakdownPanel({
      rows: [], workers: 5, windowStart: BEFORE, capturedSince: SINCE, rowLimit: 5000,
    });
    expect(p.windowPredatesCapture).toBe(true);
    expect(p.totalCalls).toBe(0);
    expect(p.actions).toEqual([]);
  });

  it('marks counts as floors when the row cap was hit', () => {
    const many = rows(...Array.from({ length: 50 }, () => 'claim_task'));
    expect(buildActionBreakdownPanel({
      rows: many, workers: 5, windowStart: AFTER, capturedSince: SINCE, rowLimit: 50,
    }).truncated).toBe(true);
    expect(buildActionBreakdownPanel({
      rows: many, workers: 5, windowStart: AFTER, capturedSince: SINCE, rowLimit: 500,
    }).truncated).toBe(false);
  });

  it('ignores rows with no action rather than counting an empty bucket', () => {
    const p = buildActionBreakdownPanel({
      rows: [{ workerId: 'w1', action: '' }, { workerId: 'w1', action: 'claim_task' }],
      workers: 1, windowStart: AFTER, capturedSince: SINCE, rowLimit: 5000,
    });
    expect(p.actions).toHaveLength(1);
    expect(p.totalCalls).toBe(1);
  });

  it('yields zero shares rather than NaN on an empty window', () => {
    const p = buildActionBreakdownPanel({
      rows: [], workers: 0, windowStart: AFTER, capturedSince: SINCE, rowLimit: 5000,
    });
    expect(p.totalCalls).toBe(0);
    expect(p.workersWithEvents).toBe(0);
    expect(p.actions).toEqual([]);
  });
});
