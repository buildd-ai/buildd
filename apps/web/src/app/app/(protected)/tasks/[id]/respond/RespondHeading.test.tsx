/**
 * The respond page's title block. Fixtures are illustrative.
 */
import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import RespondHeading from './RespondHeading';

describe('RespondHeading', () => {
  it('puts the eyebrow on its own line above the title, not inline inside the h1', () => {
    // Regression: the eyebrow was an inline <span> inside the <h1>, so on a
    // phone "FEAT · CHECKOUT" ran straight into the first words of the title.
    const html = renderToStaticMarkup(<RespondHeading eyebrow={['feat', 'checkout']} heading="Pay in the presentment currency" />);
    const eyebrow = html.match(/<p[^>]*data-testid="respond-eyebrow"[^>]*>([^<]*)<\/p>/);
    expect(eyebrow?.[1]).toBe('feat · checkout');
    const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)?.[1] ?? '';
    expect(h1).toBe('Pay in the presentment currency');
    expect(html.indexOf('respond-eyebrow')).toBeLessThan(html.indexOf('<h1'));
  });

  it('renders no eyebrow when there is nothing to put in it', () => {
    const html = renderToStaticMarkup(<RespondHeading eyebrow={[]} heading="Just a title" />);
    expect(html).not.toContain('respond-eyebrow');
    expect(html).toContain('>Just a title</h1>');
  });
});
