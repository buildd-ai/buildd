/**
 * DesignPreview, server-rendered: the sandbox contract for untrusted design HTML.
 *
 * The design file is agent output. It must only ever load from the signed
 * storage URL inside an iframe whose sandbox is exactly `allow-scripts`, and
 * nothing of the file may be written into buildd's own document.
 *
 * Run: bun run scripts/run-unit-tests.ts apps/web/src/components/DesignPreview.test.tsx
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import DesignPreview, { type DesignPreviewProps } from './DesignPreview';

const signed = 'https://storage.example/buildd-artifacts/artifacts/ws/a1/nav.html?X-Amz-Signature=sig&X-Amz-Expires=3600';

const props: DesignPreviewProps = {
  artifactId: 'a1',
  title: 'Navigation design',
  revision: 2,
  frameUrl: signed,
  screens: [
    { id: 'phone-mission', name: 'Phone mission', viewport: { width: 390, height: 844 } },
    { id: 'desktop-mission', name: 'Desktop mission', viewport: { width: 1440, height: 900 } },
  ],
  downloadUrl: '/api/artifacts/a1/download',
  fileName: 'nav.html',
  sizeLabel: '128.8 KB',
};

const render = (p: Partial<DesignPreviewProps> = {}) => renderToStaticMarkup(<DesignPreview {...props} {...p} />);

function iframeTag(html: string): string {
  const m = /<iframe\b[^>]*>/.exec(html);
  if (!m) throw new Error('no iframe rendered');
  return m[0];
}

describe('DesignPreview sandbox', () => {
  it('frames the signed storage URL with sandbox="allow-scripts" and no referrer', () => {
    const tag = iframeTag(render());
    expect(tag).toContain('sandbox="allow-scripts"');
    expect(tag).toMatch(/referrerpolicy="no-referrer"/i);
    expect(tag).toContain(`src="${signed.replace(/&/g, '&amp;')}#phone-mission"`);
  });

  it('never grants same-origin, top navigation or popup escape', () => {
    const tag = iframeTag(render());
    for (const grant of ['allow-same-origin', 'allow-top-navigation', 'allow-popups-to-escape-sandbox', 'allow-popups', 'allow-forms', 'allow-modals']) {
      expect(tag).not.toContain(grant);
    }
    const sandbox = /sandbox="([^"]*)"/.exec(tag)![1];
    expect(sandbox.split(/\s+/).filter(Boolean)).toEqual(['allow-scripts']);
  });

  it('never inlines the design: no srcdoc, no innerHTML sink in the component', () => {
    expect(render()).not.toContain('srcdoc');
    const source = readFileSync(new URL('./DesignPreview.tsx', import.meta.url), 'utf8');
    expect(source).not.toContain('srcDoc');
    expect(source).not.toContain('dangerouslySetInnerHTML');
    expect(source).not.toMatch(/\binnerHTML\b/);
    expect(source).not.toMatch(/\bfetch\(/);
  });

  it('frames from the storage origin only, never a buildd path or a data: URL', () => {
    const src = /src="([^"]*)"/.exec(iframeTag(render()))![1];
    expect(src.startsWith('https://storage.example/')).toBe(true);
    expect(src.startsWith('/api/')).toBe(false);
    expect(src.startsWith('data:')).toBe(false);
  });
});

describe('DesignPreview chrome', () => {
  it('labels the frame "Design preview · <title> · revision N"', () => {
    const html = render();
    expect(html).toContain('Design preview · Navigation design · revision 2');
    expect(iframeTag(html)).toContain('title="Design preview · Navigation design · revision 2"');
  });

  it('lists each screen with its viewport and keeps the download', () => {
    const html = render();
    // The picker names the screen; the viewport is separate muted text.
    expect(html).toContain('Phone mission');
    expect(html).toContain('data-testid="design-viewport"');
    expect(html).not.toContain('Phone mission · 390');
    expect(html).toContain('390×844');
    expect(render({ initialScreenId: 'desktop-mission' })).toContain('1440×900');
    expect(html).toContain('href="/api/artifacts/a1/download"');
    expect(html).toContain('>Download<');
  });

  it('opens the deep-linked screen and sizes the frame to its viewport', () => {
    const html = render({ initialScreenId: 'desktop-mission' });
    const tag = iframeTag(html);
    expect(tag).toContain('#desktop-mission');
    expect(tag).toContain('width:1440px');
    expect(tag).toContain('height:900px');
  });

  it('falls back to the first screen for an unknown ?screen=', () => {
    expect(iframeTag(render({ initialScreenId: 'nope' }))).toContain('#phone-mission');
  });

  it('frames the whole file, unsized, when no screen is known', () => {
    const tag = iframeTag(render({ screens: [], initialScreenId: null }));
    expect(tag).toContain(`src="${signed.replace(/&/g, '&amp;')}"`);
    expect(tag).not.toContain('#');
    expect(tag).toContain('width:100%');
  });

  it('shows the sized box with a notice, and no iframe, when storage cannot serve the file', () => {
    const html = render({ frameUrl: null });
    expect(html).not.toContain('<iframe');
    expect(html).toContain('Preview unavailable');
    expect(html).toContain('data-testid="design-frame-box"');
    expect(html).toContain('href="/api/artifacts/a1/download"');
  });
});
