import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import Section, { isEmptyChildren } from './Section';

describe('Section', () => {
  it('renders an h2 eyebrow heading that labels the section', () => {
    const html = renderToStaticMarkup(<Section title="Needs you"><p>row</p></Section>);
    const labelledBy = html.match(/aria-labelledby="([^"]+)"/)?.[1];
    expect(labelledBy).toBeTruthy();
    expect(html).toContain(`<h2 id="${labelledBy}"`);
    expect(html).toContain('text-eyebrow');
    expect(html).toContain('Needs you');
  });

  it('shows the count and the action on the header row', () => {
    const html = renderToStaticMarkup(
      <Section title="Running" count={3} action={<a href="/all">All</a>}>
        <p>row</p>
      </Section>,
    );
    expect(html).toMatch(/Running<span class="ml-2 text-text-muted">3<\/span>/);
    expect(html).toContain('<a href="/all">All</a>');
  });

  it('renders nothing when it has no children (no orphaned header)', () => {
    expect(renderToStaticMarkup(<Section title="Empty" />)).toBe('');
    expect(renderToStaticMarkup(<Section title="Empty">{null}{false}{[]}</Section>)).toBe('');
  });

  it('isEmptyChildren treats a zero as content', () => {
    expect(isEmptyChildren(0)).toBe(false);
    expect(isEmptyChildren(undefined)).toBe(true);
  });
});
