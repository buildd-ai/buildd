/**
 * Public share page body for code-shaped artifacts: `data` and `diff` go
 * through the same ArtifactCodeBody as the in-app artifact page, so a shared
 * markdown diff renders as markdown and a raw diff wraps on a phone (it used
 * to render `diff` as nothing at all, and `data` as a no-wrap <pre>).
 * Fixtures are illustrative.
 */
import { describe, expect, it, mock } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

let row: Record<string, unknown> | null = null;
mock.module('@buildd/core/db', () => ({
  db: { query: { artifacts: { findFirst: async () => row } } },
}));

const { default: SharePage } = await import('./page');

async function render(type: string, content: string) {
  row = { id: 'a-1', type, title: 'Shared thing', content, metadata: {}, storageKey: null, shareToken: 'tok', worker: null };
  return renderToStaticMarkup(await SharePage({ params: Promise.resolve({ token: 'tok' }) }));
}

describe('share page, code-shaped artifacts', () => {
  it('renders a markdown diff as markdown', async () => {
    const html = await render('diff', '## What changed\n\n- one\n');
    expect(html).toContain('<h2');
    expect(html).not.toContain('<pre');
  });

  it('renders a raw diff in a pre that wraps below md', async () => {
    const html = await render('diff', 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n');
    const pre = html.match(/<pre\b[^>]*>/)![0];
    expect(pre).toContain('whitespace-pre-wrap');
    expect(pre).toContain('text-[#ccc]');
  });

  it('pretty-prints data', async () => {
    const html = await render('data', '{"a":1}');
    expect(html).toContain('&quot;a&quot;: 1');
    expect(html.match(/<pre\b[^>]*>/)![0]).toContain('whitespace-pre-wrap');
  });
});
