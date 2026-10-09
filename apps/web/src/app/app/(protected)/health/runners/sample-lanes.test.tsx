import { expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { RunnerLanes } from '@/components/fleet/runner-lanes';
import { sampleRunnerLanes, resolveRunnerLanesSample } from './sample-lanes';

it('only enables the synthetic chart in development', () => {
  expect(resolveRunnerLanesSample('sample', 'production')).toBe(false);
  expect(resolveRunnerLanesSample(['sample'], 'development')).toBe(true);
  expect(resolveRunnerLanesSample(undefined, 'development')).toBe(false);
});
it('the sample uses current time and selectable mission bars with task links', () => {
  const now = Date.now();
  const sample = sampleRunnerLanes(now);
  expect(sample.fleet.window.to).toBe(now);
  const bars = sample.fleet.runners.flatMap(r => r.slots.flatMap(s => s.lane.bars));
  expect(bars.filter(b => b.missionId === 'sample-mission')).toHaveLength(2);
  expect(bars.every(b => b.href)).toBe(true);
  const html = renderToStaticMarkup(<RunnerLanes {...sample} now={now} />);
  expect(html).toContain('Tap a run to highlight');
  expect(html).toContain('runner-lanes-chart');
});
