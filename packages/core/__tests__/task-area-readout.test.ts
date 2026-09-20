import { describe, expect, it } from 'bun:test';
import {
  computeTaskAreaReadout,
  formatTaskAreaReadout,
  type TaskAreaRow,
} from '../task-area-readout';

const row = (over: Partial<TaskAreaRow> = {}): TaskAreaRow => ({
  taskId: over.taskId ?? 'task-1',
  arm: 'regex_paths',
  policyVersion: 'task-area-v1',
  predictedPathSource: 'diff',
  predictedPaths: [],
  regexPaths: [],
  actualPaths: null,
  neighboursConsidered: 0,
  topScore: null,
  ...over,
});

describe('computeTaskAreaReadout', () => {
  it('is indeterminate — not "no difference" — until a diff is recorded', () => {
    const out = computeTaskAreaReadout([row({ predictedPaths: ['a/b.ts'] })], 'task-area-v1');
    expect(out.indeterminate).toBe(true);
    expect(out.scored).toBe(0);
    expect(out.rows).toBe(1);
  });

  it('excludes an unscored row from the means but still counts it as assigned', () => {
    const out = computeTaskAreaReadout([
      row({ taskId: 't1', predictedPaths: ['a/b.ts'], actualPaths: ['a/b.ts'] }),
      row({ taskId: 't2', predictedPaths: [] }),
    ], 'task-area-v1');
    const control = out.arms.find(a => a.arm === 'regex_paths')!;
    expect(control.assigned).toBe(2);
    expect(control.scored).toBe(1);
    // Would be 50% if the unscored row were averaged in as a zero.
    expect(control.predictors.neighbour.meanRecall).toBe(1);
  });

  it('scores both predictors over the same rows', () => {
    const out = computeTaskAreaReadout([
      row({
        taskId: 't1',
        predictedPaths: ['apps/web/a.ts', 'apps/web/b.ts'],
        regexPaths: ['apps/web/a.ts'],
        actualPaths: ['apps/web/a.ts', 'apps/web/b.ts'],
      }),
    ], 'task-area-v1');
    const control = out.arms.find(a => a.arm === 'regex_paths')!;
    expect(control.predictors.neighbour.meanRecall).toBe(1);
    expect(control.predictors.regex.meanRecall).toBe(0.5);
    expect(control.predictors.neighbour.scored).toBe(control.predictors.regex.scored);
  });

  it('reports a tie plainly rather than finding a winner', () => {
    const out = computeTaskAreaReadout([
      row({ taskId: 't1', predictedPaths: ['x/a.ts'], regexPaths: ['x/a.ts'], actualPaths: ['x/a.ts'] }),
    ], 'task-area-v1');
    const control = out.arms.find(a => a.arm === 'regex_paths')!;
    expect(control.predictors.neighbour.meanRecall).toBe(control.predictors.regex.meanRecall);
    expect(out.indeterminate).toBe(false);
  });

  it('never pools the arms', () => {
    const out = computeTaskAreaReadout([
      row({ taskId: 't1', arm: 'regex_paths', predictedPaths: [], actualPaths: ['a/b.ts'] }),
      row({ taskId: 't2', arm: 'neighbour_area', predictedPaths: ['a/b.ts'], actualPaths: ['a/b.ts'] }),
    ], 'task-area-v1');
    expect(out.arms.map(a => a.arm)).toEqual(['regex_paths', 'neighbour_area']);
    expect(out.arms.find(a => a.arm === 'regex_paths')!.predictors.neighbour.meanRecall).toBe(0);
    expect(out.arms.find(a => a.arm === 'neighbour_area')!.predictors.neighbour.meanRecall).toBe(1);
    expect(out).not.toHaveProperty('pooled');
  });

  it('tracks how often the corpus had nothing to offer', () => {
    const out = computeTaskAreaReadout([
      row({ taskId: 't1', neighboursConsidered: 0, actualPaths: ['a/b.ts'] }),
      row({ taskId: 't2', neighboursConsidered: 4, actualPaths: ['a/b.ts'] }),
    ], 'task-area-v1');
    const control = out.arms.find(a => a.arm === 'regex_paths')!;
    expect(control.noNeighbourShare).toBe(0.5);
    expect(control.meanNeighboursConsidered).toBe(2);
  });

  it('counts how many tasks each predictor named anything for', () => {
    const out = computeTaskAreaReadout([
      row({ taskId: 't1', predictedPaths: ['a/b.ts'], regexPaths: [], actualPaths: ['a/b.ts'] }),
      row({ taskId: 't2', predictedPaths: [], regexPaths: ['a/b.ts'], actualPaths: ['a/b.ts'] }),
    ], 'task-area-v1');
    const control = out.arms.find(a => a.arm === 'regex_paths')!;
    expect(control.predictors.neighbour.withPrediction).toBe(1);
    expect(control.predictors.regex.withPrediction).toBe(1);
  });

  it('surfaces mixed path sources, which make rows incomparable', () => {
    const out = computeTaskAreaReadout([
      row({ taskId: 't1', predictedPathSource: 'diff', actualPaths: ['a/b.ts'] }),
      row({ taskId: 't2', predictedPathSource: 'manifest', actualPaths: ['a/b.ts'] }),
    ], 'task-area-v1');
    expect(out.pathSources).toEqual(['diff', 'manifest']);
    expect(formatTaskAreaReadout(out)).toContain('WARNING');
  });
});

describe('formatTaskAreaReadout', () => {
  it('prints both predictors in both arms and says why they are not pooled', () => {
    const out = computeTaskAreaReadout([
      row({ taskId: 't1', arm: 'regex_paths', predictedPaths: ['x/a.ts'], regexPaths: [], actualPaths: ['x/a.ts'] }),
      row({ taskId: 't2', arm: 'neighbour_area', predictedPaths: ['x/a.ts'], regexPaths: [], actualPaths: ['x/a.ts'] }),
    ], 'task-area-v1');
    const text = formatTaskAreaReadout(out);
    expect(text).toContain('arm regex_paths');
    expect(text).toContain('arm neighbour_area');
    expect(text).toContain('neighbour');
    expect(text).toContain('regex');
    expect(text).toContain('never pooled');
  });

  it('says it cannot see, rather than reporting zeroes, when nothing is scored', () => {
    const text = formatTaskAreaReadout(computeTaskAreaReadout([row()], 'task-area-v1'));
    expect(text).toContain('nothing is measurable');
    expect(text).not.toContain('arm regex_paths');
  });
});
