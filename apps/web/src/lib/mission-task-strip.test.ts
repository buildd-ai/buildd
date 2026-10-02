import { describe, expect, it } from 'bun:test';
import type { BoardStatus } from './mission-board';
import {
  defaultStripSelection, nextOpenIndex, openIndices, stepIndex, stripCaretLeft, stripKeyTarget, stripOrder, stripTick,
} from './mission-task-strip';

const statuses: Record<string, BoardStatus> = { a: 'merged', b: 'merged', c: 'ready', d: 'done', e: 'failed' };
const statusOf = (id: string) => statuses[id];
const order = ['a', 'b', 'c', 'd', 'e'];

describe('stripOrder', () => {
  it('is phase order, then task order within a phase', () => {
    expect(stripOrder({ phases: [{ taskIds: ['a', 'b'] }, { taskIds: ['c'] }] } as never)).toEqual(['a', 'b', 'c']);
  });
});

describe('defaultStripSelection', () => {
  it('is the first unfinished task in strip order', () => {
    expect(defaultStripSelection(order, statusOf)).toBe('c');
  });
  it('is the last task when everything landed', () => {
    expect(defaultStripSelection(['a', 'b', 'd'], statusOf)).toBe('d');
  });
  it('is the situation block\'s task when the strip has it', () => {
    expect(defaultStripSelection(order, statusOf, 'e')).toBe('e');
    expect(defaultStripSelection(order, statusOf, 'zz')).toBe('c');
  });
  it('is nothing for an empty strip', () => {
    expect(defaultStripSelection([], statusOf)).toBeNull();
  });
});

describe('stepping', () => {
  it('next open wraps, and is the selection itself when it is the only one', () => {
    const open = openIndices(order, statusOf);
    expect(open).toEqual([2, 4]);
    expect(nextOpenIndex(open, 2)).toBe(4);
    expect(nextOpenIndex(open, 4)).toBe(2);
    expect(nextOpenIndex([2], 2)).toBe(2);
    expect(nextOpenIndex([], 0)).toBeNull();
  });
  it('arrows step with wrap; Home/End jump; other keys are not the strip\'s', () => {
    expect(stripKeyTarget('ArrowRight', 4, 5)).toBe(0);
    expect(stripKeyTarget('ArrowLeft', 0, 5)).toBe(4);
    expect(stripKeyTarget('Home', 3, 5)).toBe(0);
    expect(stripKeyTarget('End', 0, 5)).toBe(4);
    expect(stripKeyTarget('Enter', 0, 5)).toBeNull();
    expect(stepIndex(1, -3, 5)).toBe(3);
  });
});

describe('stripCaretLeft', () => {
  it('centres on cell i under a flex gap', () => {
    expect(stripCaretLeft(0, 10)).toBe('calc((100% - var(--strip-gap) * 9) * 0.05 + var(--strip-gap) * 0)');
    expect(stripCaretLeft(8, 10)).toBe('calc((100% - var(--strip-gap) * 9) * 0.85 + var(--strip-gap) * 8)');
  });
  it('ticks are two digits', () => {
    expect(stripTick(8)).toBe('09');
  });
});
