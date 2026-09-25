import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import NotFound from './not-found';

describe('root not-found', () => {
  it('uses the brand tokens instead of inline system-font styles', () => {
    const html = renderToStaticMarkup(<NotFound />);
    expect(html).not.toContain('system-ui');
    expect(html).not.toContain('style=');
    expect(html).toContain('card');
    // The home link is the branded primary button (class and href on the same <a>).
    const link = html.match(/<a[^>]*>Go home<\/a>/)?.[0] ?? '';
    expect(link).toContain('href="/app/home"');
    expect(link).toMatch(/class="btn btn-primary[\s"]/);
  });
});
