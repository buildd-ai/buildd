import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { StatStrip, type StatStripProps } from './StatStrip';

const base: StatStripProps = {
  live: 0,
  capacity: 4,
  runners: 1,
  needsYou: 0,
  needsYouDetail: null,
  mergedToday: 0,
  mergedDetail: null,
  prsInCi: [],
  selfHealed: 0,
  screensReviewed: null,
};

describe('StatStrip', () => {
  it('says "nothing merged", not a dash, when merged today has no detail', () => {
    const html = renderToStaticMarkup(<StatStrip {...base} />);
    expect(html).toContain('nothing merged');
    expect(html).not.toContain('—');
  });

  it('shows the merged detail when one is present', () => {
    const html = renderToStaticMarkup(<StatStrip {...base} mergedDetail="#451 #450" />);
    expect(html).toContain('#451 #450');
    expect(html).not.toContain('nothing merged');
  });
});
