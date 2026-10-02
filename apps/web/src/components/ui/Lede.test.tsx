import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import Lede from './Lede';

describe('Lede', () => {
  it('renders a paragraph on the lede type role', () => {
    const html = renderToStaticMarkup(<Lede>Two tasks are waiting on your approval.</Lede>);
    expect(html).toMatch(/^<p class="[^"]*text-lede/);
    expect(html).toContain('Two tasks are waiting on your approval.');
  });

  it('can render as a div and keeps extra classes', () => {
    expect(renderToStaticMarkup(<Lede as="div" className="mt-2">x</Lede>)).toMatch(/^<div class="[^"]*mt-2"/);
  });
});
