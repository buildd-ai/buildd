import { describe, expect, it } from 'bun:test';
import { miniBoardColumns, miniStatusTone } from './mini-board';
import type { MissionBoardModel } from '@/lib/mission-board';

function model(phases: Array<[string | null, Array<[string, string]>]>): MissionBoardModel {
  const tasks: Record<string, unknown> = {};
  const out = phases.map(([label, ts], i) => {
    ts.forEach(([id, status]) => { tasks[id] = { id, label: id, scope: null, status }; });
    const done = ts.filter(([, s]) => s === 'merged' || s === 'done').length;
    return { key: `p${i}`, ordinal: i + 1, label, taskIds: ts.map(([id]) => id), done, total: ts.length };
  });
  return { phases: out, tasks } as unknown as MissionBoardModel;
}

describe('miniBoardColumns', () => {
  it('one column per phase, in order, with its done/total', () => {
    const cols = miniBoardColumns(model([['Foundations', [['db', 'merged'], ['fx', 'running']]], ['Prove it', [['e2e', 'blocked']]]]));
    expect(cols.map(c => c.title)).toEqual(['1 Foundations', '2 Prove it']);
    expect(cols[0].count).toBe('1/2');
    expect(cols[0].rows.map(r => r.id)).toEqual(['db', 'fx']);
  });

  it('caps rows per column and counts the rest, keeping what needs you in view', () => {
    const cols = miniBoardColumns(model([[null, [['a', 'merged'], ['b', 'merged'], ['c', 'merged'], ['d', 'running'], ['e', 'waiting']]]]), 3);
    expect(cols[0].title).toBe('Phase 1');
    expect(cols[0].rows.map(r => r.id)).toEqual(['e', 'd', 'a']);
    expect(cols[0].more).toBe(2);
  });

  it('keeps plan order when nothing is capped', () => {
    const cols = miniBoardColumns(model([['X', [['a', 'merged'], ['b', 'waiting'], ['c', 'ready']]]]));
    expect(cols[0].rows.map(r => r.id)).toEqual(['a', 'b', 'c']);
  });

  it('an empty plan has no columns', () => {
    expect(miniBoardColumns(model([]))).toEqual([]);
  });
});

describe('miniStatusTone', () => {
  it('landed is ok, live is accent, a question is attention, red is bad, queued is idle', () => {
    expect(miniStatusTone('merged')).toBe('ok');
    expect(miniStatusTone('done')).toBe('ok');
    expect(miniStatusTone('running')).toBe('live');
    expect(miniStatusTone('fixing')).toBe('bad');
    expect(miniStatusTone('waiting')).toBe('attention');
    expect(miniStatusTone('ci_failed')).toBe('bad');
    expect(miniStatusTone('review')).toBe('review');
    expect(miniStatusTone('blocked')).toBe('idle');
    expect(miniStatusTone('ready')).toBe('idle');
  });
});
