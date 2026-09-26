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

// Agent output and task descriptions are untrusted. These lock in that the
// renderer stays inert when a plugin is added or swapped (as remark-gfm was):
// no rehype-raw, and react-markdown's default URL transform stays in place.
describe('MarkdownContent — untrusted input stays inert', () => {
  const render = (content: string) => renderToStaticMarkup(<MarkdownContent content={content} />);
  /**
   * Any real element carrying an inline event handler attribute. Quoted
   * attribute values are blanked first so escaped text inside e.g. an alt
   * (`alt="x&quot; onerror=..."`) is not mistaken for an attribute.
   */
  const hasEventAttr = (html: string) => /<[a-z][^>]*\son[a-z]+\s*=/i.test(html.replace(/"[^"]*"/g, '""'));

  it('does not render raw <script> blocks', () => {
    const html = render('before\n\n<script>alert(1)</script>\n\nafter');
    expect(html).not.toMatch(/<script/i);
    expect(html).toContain('after');
  });

  it('does not render raw HTML elements or their event handlers', () => {
    const html = render('<img src="x" onerror="alert(1)">\n\ninline <b onclick="alert(1)">bold</b> and <iframe src="https://example.com"></iframe>');
    expect(hasEventAttr(html)).toBe(false);
    expect(html).not.toMatch(/<img/i);
    expect(html).not.toMatch(/<iframe/i);
    expect(html).not.toMatch(/<b[\s>]/i);
  });

  it('does not let a markdown image carry an event handler', () => {
    const html = render('![x" onerror="alert(1)](https://example.com/a.png)');
    expect(hasEventAttr(html)).toBe(false);
    expect(html).toContain('alt="x&quot; onerror=&quot;alert(1)"');
  });

  it('the event-attribute check can fail (guards a vacuous pass)', () => {
    expect(hasEventAttr('<img src="x" onerror="alert(1)">')).toBe(true);
  });

  for (const [label, url] of [
    ['javascript:', 'javascript:alert(1)'],
    ['mixed-case javascript:', 'JaVaScRiPt:alert(1)'],
    ['vbscript:', 'vbscript:msgbox(1)'],
    ['data:text/html', 'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg=='],
  ] as const) {
    it(`strips ${label} link targets`, () => {
      const html = render(`[click me](${url})`);
      expect(html).toContain('click me');
      expect(html).not.toMatch(/href="\s*(javascript|vbscript|data):/i);
      expect(html.toLowerCase()).not.toContain(url.toLowerCase().split('(')[0].split(',')[0]);
    });
  }

  it('strips an entity-encoded javascript: link target', () => {
    const html = render('[click me](&#106;avascript:alert(1))');
    expect(html).not.toMatch(/href="[^"]*javascript:/i);
  });

  it('strips javascript: from reference-style links and image sources', () => {
    const html = render('[ref][1] ![img](javascript:alert(1))\n\n[1]: javascript:alert(1)');
    expect(html).not.toMatch(/(href|src)="[^"]*javascript:/i);
  });

  it('keeps ordinary http(s) and mailto links, opened safely', () => {
    const html = render('[site](https://example.com/x) [mail](mailto:someone@example.com)');
    expect(html).toContain('href="https://example.com/x"');
    expect(html).toContain('href="mailto:someone@example.com"');
    expect(html).toContain('rel="noopener noreferrer"');
  });
});
