/**
 * Mobile QA: the artifact page's Helpful / Not helpful buttons were 22x22.
 * The full-size variant is a 44px target below md; `compact` (dense feeds)
 * keeps its size.
 */
import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import AiFeedback from './AiFeedback';

const button = (html: string, label: string) => {
  const b = html.match(new RegExp(`<button\\b[^>]*aria-label="${label}"[^>]*>`))![0];
  return (b.match(/class="([^"]*)"/)?.[1] ?? '').split(/\s+/);
};

describe('AiFeedback touch targets', () => {
  it('Helpful and Not helpful are 44px targets below md', () => {
    const html = renderToStaticMarkup(<AiFeedback entityType="artifact" entityId="a-1" />);
    for (const label of ['Helpful', 'Not helpful']) {
      const cls = button(html, label);
      expect(cls).toContain('min-h-11');
      expect(cls).toContain('min-w-11');
      expect(cls).toContain('md:min-h-0');
    }
  });

  it('the compact variant is unchanged', () => {
    const cls = button(renderToStaticMarkup(<AiFeedback entityType="summary" entityId="s-1" compact />), 'Helpful');
    expect(cls).not.toContain('min-h-11');
  });
});
