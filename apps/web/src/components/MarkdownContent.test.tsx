import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import MarkdownContent from './MarkdownContent';

const TABLE = ['| Step | Result |', '| --- | --- |', '| build | ok |', '| test | failed |'].join('\n');

describe('MarkdownContent', () => {
  it('renders a GFM table as a <table>, not raw pipes', () => {
    const html = renderToStaticMarkup(<MarkdownContent content={TABLE} />);
    expect(html).toContain('<table');
    expect(html).toContain('<td>build</td>');
    expect(html).not.toContain('| Step |');
  });

  it('wraps tables in a horizontal scroller so wide tables never pan the page', () => {
    const html = renderToStaticMarkup(<MarkdownContent content={TABLE} />);
    const wrapper = html.match(/<div class="([^"]*)"><table/)?.[1] ?? '';
    expect(wrapper).toContain('overflow-x-auto');
  });

  it('lets long inline code wrap anywhere', () => {
    const html = renderToStaticMarkup(
      <MarkdownContent content={'See `apps/web/src/app/app/(protected)/a-very-long/path/to/some/file.tsx` here'} />,
    );
    const code = html.match(/<code class="([^"]*)"/)?.[1] ?? '';
    expect(code).toContain('[overflow-wrap:anywhere]');
  });

  it('renders GFM strikethrough and autolinks', () => {
    const html = renderToStaticMarkup(<MarkdownContent content={'~~old~~ https://example.com'} />);
    expect(html).toContain('<del>old</del>');
    expect(html).toContain('href="https://example.com"');
  });
});
