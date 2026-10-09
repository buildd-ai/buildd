import { describe, expect, it } from 'bun:test';
import { dagBoard, dagId, DAG_SPECS } from '@/app/app/dev/fixtures/mission-task-strip-fixtures';
import { stripOrder } from './mission-task-strip';
import { finishSettingTaskId, overviewCells, overviewCounts, overviewSelection } from './mission-overview';

const spec = DAG_SPECS.linear; // A landed, B running, C blocked, D/E queued
const model = dagBoard(spec);
const order = stripOrder(model);

describe('finishSettingTaskId', () => {
  it('is the first task in flight, not the first task', () => {
    expect(finishSettingTaskId(model)).toBe(dagId(spec, 'B'));
    expect(finishSettingTaskId(model)).not.toBe(order[0]);
  });

  it('prefers the first unfinished task on the critical path when estimates give one', () => {
    const path = new Set([dagId(spec, 'C'), dagId(spec, 'D')]);
    expect(finishSettingTaskId(model, order, path)).toBe(dagId(spec, 'C'));
  });

  it('ignores a critical path with nothing unfinished on it', () => {
    expect(finishSettingTaskId(model, order, new Set([dagId(spec, 'A')]))).toBe(dagId(spec, 'B'));
  });

  it('falls to the first held task when nothing is in flight, and the last when all landed', () => {
    const fanIn = dagBoard(DAG_SPECS['fan-in']);
    expect(finishSettingTaskId(fanIn)).toBeTruthy();
    expect(finishSettingTaskId({ phases: [], tasks: {} })).toBeNull();
  });
});

describe('overviewCells', () => {
  it('is one cell per task in strip order, ticked by position', () => {
    const cells = overviewCells(model);
    expect(cells.map(c => c.id)).toEqual(order);
    expect(cells.map(c => c.tick)).toEqual(['01', '02', '03', '04', '05']);
    expect(cells.map(c => c.state)).toEqual(['landed', 'running', 'blocked', 'queued', 'queued']);
  });
});

describe('overviewSelection', () => {
  it('a running task marks and names what it unblocks', () => {
    const s = overviewSelection(model, order, dagId(spec, 'B'));
    expect(s.marks.get(dagId(spec, 'C'))).toBe('direct');
    expect(s.reason).toEqual({ lead: 'Unblocks', text: '03 (+2 downstream).' });
  });

  it('a held task names what it waits behind, frontier first', () => {
    const s = overviewSelection(model, order, dagId(spec, 'E'));
    expect(s.reason?.lead).toBe('After');
    expect(s.reason?.text).toBe('04 D (+2 upstream).');
  });

  it('a landed task marks nothing', () => {
    const s = overviewSelection(model, order, dagId(spec, 'A'));
    expect(s.marks.size).toBe(0);
    expect(s.reason).toBeNull();
  });
});

describe('overviewCounts', () => {
  it('prints merged, then criteria when there are any', () => {
    expect(overviewCounts({ landed: { done: 2, total: 7 }, criteria: [], criteriaPassed: 0 } as never)).toBe('2 of 7 merged');
    expect(overviewCounts({ landed: { done: 2, total: 7 }, criteria: [{}, {}, {}, {}], criteriaPassed: 1 } as never)).toBe('2 of 7 merged · 1 of 4 criteria');
    expect(overviewCounts({ landed: { done: 2, total: 7 }, criteria: [{}, {}, {}, {}], criteriaPassed: 1 } as never, { criteria: false })).toBe('2 of 7 merged');
  });
});
