import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { MANY_DELIVERIES, NowPreview } from './YouStripPipelineFixture';

/** The fixture's Now preview: strip, Pipeline and rows from one list, as a page would compose them. */
const now = (deliveries = MANY_DELIVERIES) => renderToStaticMarkup(<NowPreview deliveries={deliveries} />);

describe('YouStrip + Pipeline over the rows (spec 9430a28f r2)', () => {
  it('AC-12: count == dots == rows in that stage group, for every stage', () => {
    const html = now();
    for (const stage of ['build', 'verify', 'deliver'] as const) {
      const cell = html.split(`data-stage="${stage}"`)[1].split('data-stage=')[0];
      const count = Number(cell.match(/data-count="(\d+)"/)![1]);
      const dots = (cell.split(`data-dots="${stage}"`)[1].match(/data-dot="/g) ?? []).length;
      const group = html.split(`data-group="${stage}"`)[1]?.split('data-group=')[0] ?? '';
      const rows = (group.match(/data-row="/g) ?? []).length;
      expect({ stage, count, dots }).toEqual({ stage, count: rows, dots: rows });
      expect(rows).toBeGreaterThan(0);
    }
  });

  it('AC-11: with nothing waiting the first element is the strip with the green dot', () => {
    const html = now(MANY_DELIVERIES.filter(d => d.state !== 'waiting-on-you'));
    expect(html.indexOf('data-testid="you-strip"')).toBeLessThan(html.indexOf('data-testid="pipeline"'));
    expect(html).toContain('Nothing waiting on you');
  });

  it('AC-11: one waiting puts its card first and its row meter reads waiting on you', () => {
    const html = now();
    const card = html.match(/data-testid="you-strip-card" data-item="([^"]+)"/);
    expect(card?.[1]).toBe('m11');
    expect(html.indexOf('you-strip-card')).toBeLessThan(html.indexOf('data-testid="pipeline"'));
    const row = html.split('data-row="m11"')[1].split('data-row=')[0];
    expect(row).toContain('data-state="waiting-on-you"');
    expect(row).toContain('aria-label="Waiting on you, at verify"');
  });
});
