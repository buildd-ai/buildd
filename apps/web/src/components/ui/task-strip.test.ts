import { describe, expect, it } from 'bun:test';
import type { StateKey } from './states';
import { STRIP_AGGREGATE_ABOVE, reasonLine, stripRunColumns, stripRunLabel, stripRuns } from './task-strip';

const fill = (state: StateKey, n: number) => Array.from({ length: n }, () => state);

describe('stripRuns (small strip aggregation)', () => {
  it('keeps one cell per task at the threshold', () => {
    const states = [...fill('landed', 10), ...fill('queued', STRIP_AGGREGATE_ABOVE - 10)];
    expect(states).toHaveLength(16);
    expect(stripRuns(states)).toHaveLength(16);
  });

  it('collapses runs of merged / ready / blocked / queued above 16 tasks', () => {
    const states: StateKey[] = [...fill('landed', 9), 'running', 'review', ...fill('blocked', 3), ...fill('queued', 4)];
    expect(states).toHaveLength(18);
    expect(stripRuns(states)).toEqual([
      { state: 'landed', count: 9 },
      { state: 'running', count: 1 },
      { state: 'review', count: 1 },
      { state: 'blocked', count: 3 },
      { state: 'queued', count: 4 },
    ]);
  });

  it('never merges anything moving: adjacent building tasks keep their own cells', () => {
    const states: StateKey[] = [...fill('landed', 14), 'running', 'running', 'fixing', 'needs_you'];
    const runs = stripRuns(states);
    expect(runs.filter(r => r.state === 'running')).toHaveLength(2);
    expect(runs.every(r => r.state === 'landed' || r.count === 1)).toBe(true);
  });

  it('sizes a segment by its count', () => {
    expect(stripRunColumns([{ state: 'landed', count: 9 }, { state: 'running', count: 1 }])).toBe('9fr minmax(6px,1fr)');
  });

  it('labels only wide segments', () => {
    expect(stripRunLabel({ state: 'landed', count: 9 })).toBe('9 merged');
    expect(stripRunLabel({ state: 'queued', count: 4 })).toBe('4 queued');
    expect(stripRunLabel({ state: 'queued', count: 3 })).toBeNull();
  });
});

describe('reasonLine (SEL-2)', () => {
  it('names at most two and tails the rest upstream', () => {
    expect(reasonLine('upstream', ['03 Projection', '04 List', '05 Activity'], 5)).toEqual({
      lead: 'After',
      text: '03 Projection, 04 List (+3 upstream).',
    });
  });

  it('downstream reads Unblocks, with no tail when nothing is left', () => {
    expect(reasonLine('downstream', ['05', '06'])).toEqual({ lead: 'Unblocks', text: '05, 06.' });
  });

  it('tails the rest downstream', () => {
    expect(reasonLine('downstream', ['08', '13', '14'], 6)?.text).toBe('08, 13 (+4 downstream).');
  });

  it('has nothing to say with no names', () => {
    expect(reasonLine('upstream', [])).toBeNull();
  });
});
