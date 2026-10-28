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
  const now = Date.parse('2026-10-27T12:00:00Z');
  const view = sampleQueueView(now);
  expect(view.lanes.some(l => l.holder)).toBe(true);
  expect(view.lanes.some(l => l.stuckFor)).toBe(true);
  expect(view.waiting.rows.map(r => r.reason).sort()).toEqual(['declared', 'lane', 'limit', 'limit']);
  expect(view.waiting.rows.some(r => r.forceable)).toBe(true);
  const html = renderToStaticMarkup(<QueueBoard view={view} now={now} onFilter={noop} onPage={noop} onOpenLane={noop} onStart={noop} />);
  expect(html).toContain('data-testid="queue-stuck-lane"');
  expect(html).toContain('Force start');
});
