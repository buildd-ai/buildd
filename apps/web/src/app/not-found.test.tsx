import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import NotFound from './not-found';

describe('root not-found', () => {
  it('uses the brand tokens instead of inline system-font styles', () => {
    const html = renderToStaticMarkup(<NotFound />);
    expect(html).not.toContain('system-ui');
    expect(html).not.toContain('style=');
    expect(html).toContain('card');
    expect(html).toMatch(/class="btn btn-primary[^"]*"[^>]*>Go home|href="\/app\/home"/);
  });
});
