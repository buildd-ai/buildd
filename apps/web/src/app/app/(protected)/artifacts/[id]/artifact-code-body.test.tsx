/**
 * Mobile QA: a `diff` artifact whose content was a markdown write-up rendered
 * as one no-wrap <pre>, thousands of px wide on a phone. Markdown goes through
 * MarkdownContent; a raw unified diff or JSON wraps below md and is contained.
 */
import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ArtifactCodeBody, isRawUnifiedDiff } from './artifact-code-body';

const RAW = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,3 @@
-const a = 1;
+const a = 2;
`;

const MD = `## What changed

- Renamed the helper in \`src/a.ts\`
- Added a regression test

\`\`\`diff
-const a = 1;
+const a = 2;
\`\`\`
`;

describe('isRawUnifiedDiff', () => {
  it('recognises git and plain unified diffs', () => {
    expect(isRawUnifiedDiff(RAW)).toBe(true);
    expect(isRawUnifiedDiff('--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n')).toBe(true);
    expect(isRawUnifiedDiff('\n\n@@ -1 +1 @@\n-a\n+b\n')).toBe(true);
  });

  it('treats a markdown write-up as not a raw diff, even with a fenced diff inside', () => {
    expect(isRawUnifiedDiff(MD)).toBe(false);
  });
});

describe('ArtifactCodeBody', () => {
  it('renders a markdown diff artifact as markdown, not a <pre> blob', () => {
    const html = renderToStaticMarkup(<ArtifactCodeBody type="diff" content={MD} />);
    expect(html).toContain('<h2');
    expect(html).toContain('<li');
  });

  it('renders a raw diff in a pre that wraps below md and scrolls in place at md+', () => {
    const html = renderToStaticMarkup(<ArtifactCodeBody type="diff" content={RAW} />);
    const pre = html.match(/<pre\b[^>]*>/)![0];
    for (const c of ['whitespace-pre-wrap', 'md:whitespace-pre', 'overflow-x-auto', 'max-w-full']) {
      expect(pre).toContain(c);
    }
  });

  it('pretty-prints JSON data and keeps it contained', () => {
    const html = renderToStaticMarkup(<ArtifactCodeBody type="data" content='{"a":1}' />);
    expect(html).toContain('&quot;a&quot;: 1');
    expect(html.match(/<pre\b[^>]*>/)![0]).toContain('whitespace-pre-wrap');
  });
});
