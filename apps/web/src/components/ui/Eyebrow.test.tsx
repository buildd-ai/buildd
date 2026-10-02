import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import Eyebrow from './Eyebrow';

describe('Eyebrow', () => {
  it('renders a span on the eyebrow type role by default', () => {
    const html = renderToStaticMarkup(<Eyebrow>Missions</Eyebrow>);
    expect(html).toMatch(/^<span /);
    expect(html).toContain('text-eyebrow');
    expect(html).toContain('uppercase');
    expect(html).toContain('text-text-primary');
  });

  it('renders as a heading when asked', () => {
    expect(renderToStaticMarkup(<Eyebrow as="h2" id="h">Recent</Eyebrow>)).toMatch(/^<h2 id="h" /);
  });

  it('maps tones to text tokens', () => {
    expect(renderToStaticMarkup(<Eyebrow tone="muted">x</Eyebrow>)).toContain('text-text-muted');
    expect(renderToStaticMarkup(<Eyebrow tone="accent">x</Eyebrow>)).toContain('text-accent-text');
  });
});
