import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import PageColumn from './PageColumn';

describe('PageColumn', () => {
  it('centres the content at the reading width', () => {
    const html = renderToStaticMarkup(<PageColumn>body</PageColumn>);
    expect(html).toMatch(/^<div data-page-column="" class="mx-auto w-full max-w-\[var\(--content-measure\)\]">body<\/div>$/);
  });

  it('can render as a section and keeps extra classes', () => {
    expect(renderToStaticMarkup(<PageColumn as="section" className="px-4">x</PageColumn>)).toMatch(/^<section [^>]*class="[^"]*max-w-\[var\(--content-measure\)\] px-4"/);
  });

  it('the token is about 840px, inside the spec’s 760 to 900px (Navigation R-21, AC-13)', () => {
    const css = readFileSync(join(import.meta.dir, '..', '..', 'app', 'globals.css'), 'utf8');
    const m = /--content-measure:\s*(\d+)px/.exec(css);
    expect(m).not.toBeNull();
    const px = Number(m![1]);
    expect(px).toBeGreaterThanOrEqual(760);
    expect(px).toBeLessThanOrEqual(900);
  });
});
