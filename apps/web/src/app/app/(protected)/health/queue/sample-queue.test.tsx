import { expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import QueueBoard from './QueueBoard';
import { resolveQueueSample, sampleQueueView } from './sample-queue';

const noop = () => {};

it('only enables the sample in development', () => {
  expect(resolveQueueSample('sample', 'production')).toBe(false);
  expect(resolveQueueSample(['sample'], 'development')).toBe(true);
  expect(resolveQueueSample(undefined, 'development')).toBe(false);
});
it('the sample renders every new queue state', () => {
  const view = sampleQueueView(Date.parse('2026-10-27T12:00:00Z'));
  expect(view.lanes.some(l => l.holder)).toBe(true);
  expect(view.lanes.some(l => l.stuckFor)).toBe(true);
  expect(view.waiting.rows.map(r => r.reason).sort()).toEqual(['declared', 'lane', 'limit', 'limit']);
  expect(view.waiting.rows.some(r => r.forceable)).toBe(true);
  const html = renderToStaticMarkup(<QueueBoard view={view} onFilter={noop} onPage={noop} onOpenLane={noop} onOpenRow={noop} onForce={noop} />);
  expect(html).toContain('running, over 3 slots');
  expect(html).toContain('Force start');
});
