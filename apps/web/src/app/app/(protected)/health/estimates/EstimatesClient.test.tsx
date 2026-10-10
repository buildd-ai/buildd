import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { EstimatesClient } from './EstimatesClient';
import type { TaskEstimateReadout } from '@buildd/core/task-estimate-accuracy';

const score = (scored: number, withinP80: number | null) => ({ n: scored, scored, withinP80, medianRatio: 1, medianAbsLogError: 0.2 });
const readout = (over: Partial<TaskEstimateReadout> = {}): TaskEstimateReadout => ({
  estimatorVersion: 'blend-v1', rows: 40, overall: score(40, 0.9), tokens: score(40, 0.8), repairs: null,
  bySource: [{ key: 'neighbours', score: score(30, 0.9) }, { key: 'prior', score: score(10, 0.6) }],
  byKind: [{ key: 'feature', score: score(25, 0.9) }],
  byCluster: [{ key: 'apps/web/missions', score: score(12, 0.95) }],
  byHistory: [{ band: '0-4', score: score(8, 0.6) }, { band: '5+', score: score(32, 0.95) }],
  indeterminate: false, ...over,
});

describe('EstimatesClient', () => {
  test('leads with the result, then details with scatter, groups and n', () => {
    const html = renderToStaticMarkup(<EstimatesClient readout={readout()} points={[{ estimate: 30, actual: 40, p80: 50 }]} />);
    expect(html).toContain('Most tasks finished within estimate.');
    expect(html).toContain('9 in 10 finished within the upper estimate. Based on 40 tasks.');
    expect(html).toContain('estimates-scatter');
    expect(html).toContain('apps/web/missions');
    expect(html).toContain('n 12');
    expect(html).toContain('Learning curve');
    expect(html).not.toMatch(/uppercase|font-mono/);
  });
  test('with nothing scorable there is a lead and no details', () => {
    const html = renderToStaticMarkup(<EstimatesClient readout={readout({ indeterminate: true, overall: score(0, null) })} points={[]} />);
    expect(html).toContain('Not enough finished tasks');
    expect(html).not.toContain('estimates-details');
  });
});
