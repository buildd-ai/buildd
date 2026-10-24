import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import QueueTiles, { blockedSplitWords } from './QueueTiles';

const HREFS = { running: '/r', queued: '/q', blocked: '/b', scheduled: '/s' };
const render = (over: Partial<Parameters<typeof QueueTiles>[0]> = {}) =>
  renderToStaticMarkup(
    <QueueTiles running={{ used: 4, total: 6 }} queued={2} blocked={{ lane: 3, limit: 2, dependency: 4 }} scheduled={1} hrefs={HREFS} {...over} />,
  );

describe('QueueTiles', () => {
  it('reads 4/6, 2, 9, 1 and each tile links to its rows (AC-1)', () => {
    const html = render();
    for (const [href, value] of [['/r', '4/6'], ['/q', '2'], ['/b', '9'], ['/s', '1']]) {
      expect(html).toMatch(new RegExp(`<a[^>]*href="${href}"[^>]*>.*?${value}</span>`));
    }
    expect(html).toContain('/6 slots in use');
  });

  it('Running takes the same slot numbers as Capacity (AC-14)', () => {
    const html = render({ running: { used: 3, total: 9 } });
    expect(html).toContain('3/9');
    expect(html).toContain('/9 slots in use');
  });

  it('Blocked carries a stacked bar by reason and the split in words', () => {
    const html = render();
    expect(html).toContain('3 lane · 2 limit · 4 dependency');
    expect(html).toContain('width:33.33');
    expect(blockedSplitWords({ lane: 0, limit: 2, dependency: 0 })).toBe('2 limit');
  });

  it('draws no bar when nothing is blocked', () => {
    const html = render({ blocked: { lane: 0, limit: 0, dependency: 0 } });
    expect(html).not.toContain('queue-blocked-bar');
  });

  it('is two columns on a phone and four on desktop', () => {
    expect(render({ layout: 'phone' })).toContain('grid-cols-2');
    expect(render({ layout: 'desktop' })).toContain('grid-cols-4');
  });

  it('uses the catalog words, none of the retired ones', () => {
    const html = render();
    expect(html).not.toMatch(/Parked|Declared|Waiting|>Ready</);
  });
});
