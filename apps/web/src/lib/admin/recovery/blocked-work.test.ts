import { describe, it, expect } from 'bun:test';
import { computeBlockedWork, unblocksOf, type BlockEpisode } from './blocked-work';

const H = 3_600_000;
const NOW = Date.parse('2026-10-11T12:00:00.000Z');
const ep = (causeKey: string, subjectTaskId: string, startH: number, over: Partial<BlockEpisode> = {}): BlockEpisode =>
  ({ causeKey, subjectTaskId, blockerTaskId: null, startMs: NOW - startH * H, endMs: null, ...over });
const byKey = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const run = (episodes: BlockEpisode[], windowH = 24, prefer = byKey) =>
  computeBlockedWork({ episodes, windowStartMs: NOW - windowH * H, nowMs: NOW, prefer });

describe('blocked task-hours', () => {
  it('unions one task’s overlapping intervals inside a cause', () => {
    const r = run([ep('A', 't1', 4), ep('A', 't1', 2)]);
    expect(r.perCause.get('A')!.hours).toBeCloseTo(4);
    expect(r.totalHours).toBeCloseTo(4);
  });

  it('clips to the window and stops at the episode end (first progress)', () => {
    const r = run([ep('A', 't1', 30, { endMs: NOW - 20 * H }), ep('A', 't2', 3, { endMs: NOW - 1 * H })]);
    expect(r.perCause.get('A')!.hours).toBeCloseTo(4 + 2);
  });

  it('a task blocked by two independent roots counts once, for the preferred cause', () => {
    const prefer = (a: string, b: string) => (a === 'B' ? -1 : b === 'B' ? 1 : 0);
    const r = run([ep('A', 't1', 5), ep('B', 't1', 5)], 24, prefer);
    expect(r.perCause.get('B')!.hours).toBeCloseTo(5);
    expect(r.perCause.get('A')!.hours).toBeCloseTo(0);
    expect(r.totalHours).toBeCloseTo(5);
  });

  it('F-11 cascade: B’s downstream hours go to root A, counted once; total equals the union', () => {
    // Cause A blocks t1..t4; t1 blocks t5..t7 under cause B.
    const episodes = [
      ...['t1', 't2', 't3', 't4'].map(t => ep('A', t, 6, { blockerTaskId: 'holder' })),
      ...['t5', 't6', 't7'].map(t => ep('B', t, 3, { blockerTaskId: 't1' })),
    ];
    const r = run(episodes);
    expect(r.perCause.get('A')!.hours).toBeCloseTo(4 * 6 + 3 * 3);
    expect(r.perCause.get('B')!.hours).toBeCloseTo(0);
    expect(r.perCause.get('B')!.waitsBehind.get('A')!.size).toBe(3);
    const sum = [...r.perCause.values()].reduce((s, c) => s + c.hours, 0);
    expect(sum).toBeCloseTo(r.totalHours);
    expect(unblocksOf('A', episodes).size).toBe(7);
    expect(unblocksOf('B', episodes).size).toBe(3);
  });

  it('a cycle attributes once, to the cycle’s cause', () => {
    const episodes = [
      ep('X', 't1', 2, { blockerTaskId: 't2' }),
      ep('C', 't2', 2, { blockerTaskId: 't1', cycle: true }),
    ];
    const r = run(episodes);
    expect(r.perCause.get('C')!.hours).toBeCloseTo(4);
    expect(r.perCause.get('X')!.hours).toBeCloseTo(0);
    expect(r.totalHours).toBeCloseTo(4);
  });

  it('a closed upstream episode no longer captures downstream hours', () => {
    const r = run([ep('A', 't1', 6, { endMs: NOW - 5 * H }), ep('B', 't5', 3, { blockerTaskId: 't1' })]);
    expect(r.perCause.get('B')!.hours).toBeCloseTo(3);
  });

  it('blockedNow counts each cause’s open subjects', () => {
    const r = run([ep('A', 't1', 2), ep('A', 't2', 2, { endMs: NOW - H }), ep('A', 't1', 1)]);
    expect([...r.perCause.get('A')!.blockedNow]).toEqual(['t1']);
  });
});
