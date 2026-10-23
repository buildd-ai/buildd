/**
 * Pure helpers behind the design preview on /app/artifacts/[id]:
 * which file artifacts count as a design, how its screens and their viewports
 * are read (metadata first, the HTML's own `data-screen`/`data-viewport`
 * sections second, a prefix guess last), and the deep-link / frame-URL shapes.
 *
 * Run: bun run scripts/run-unit-tests.ts apps/web/src/lib/design-preview.test.ts
 */
import { describe, expect, it } from 'bun:test';
import {
  designPreviewHref,
  fitScale,
  frameSrc,
  inferViewport,
  isDesignArtifact,
  parseViewport,
  resolveDesignScreens,
  screensFromHtml,
  screensFromMetadata,
} from './design-preview';

const html = `<!doctype html><html><body>
<section data-screen="phone-mission" data-viewport="390x844" data-name="Mission (phone)"><h1>x</h1></section>
<section class="s" data-viewport='1440x900' data-screen='desktop-mission'></section>
<section data-screen="coverage"></section>
<div data-screen="not-a-section" data-viewport="1x1"></div>
</body></html>`;

describe('isDesignArtifact', () => {
  const base = { storageKey: 'artifacts/ws/a/design.html', metadata: { mimeType: 'text/html' } as Record<string, unknown> };
  it('is a design when the HTML file says kind design', () => {
    expect(isDesignArtifact({ ...base, metadata: { ...base.metadata, kind: 'design' } })).toBe(true);
  });
  it('is a design when the HTML file lists screens', () => {
    expect(isDesignArtifact({ ...base, metadata: { ...base.metadata, screens: ['a'] } })).toBe(true);
  });
  it('is not a design without screens or the kind, nor for a non-HTML file, nor without a stored file', () => {
    expect(isDesignArtifact(base)).toBe(false);
    expect(isDesignArtifact({ ...base, metadata: { mimeType: 'application/pdf', kind: 'design' } })).toBe(false);
    expect(isDesignArtifact({ storageKey: null, metadata: { mimeType: 'text/html', kind: 'design' } })).toBe(false);
    expect(isDesignArtifact({ storageKey: 'k', metadata: null })).toBe(false);
  });
  it('a design buildd stored (inert text/plain) is a design', () => {
    expect(isDesignArtifact({ ...base, metadata: { mimeType: 'text/plain; charset=utf-8', kind: 'design' } })).toBe(true);
    expect(isDesignArtifact({ ...base, metadata: { mimeType: 'text/plain', screens: ['a'] } })).toBe(false);
  });
  it('accepts a charset suffix on the mime type', () => {
    expect(isDesignArtifact({ ...base, metadata: { mimeType: 'text/html; charset=utf-8', kind: 'design' } })).toBe(true);
  });
});

describe('parseViewport', () => {
  it('reads WxH strings and {width,height} objects', () => {
    expect(parseViewport('390x844')).toEqual({ width: 390, height: 844 });
    expect(parseViewport('1440×900')).toEqual({ width: 1440, height: 900 });
    expect(parseViewport({ width: 1280, height: 800 })).toEqual({ width: 1280, height: 800 });
  });
  it('rejects nonsense and non-positive sizes', () => {
    expect(parseViewport('wide')).toBeNull();
    expect(parseViewport('0x100')).toBeNull();
    expect(parseViewport({ width: -1, height: 2 })).toBeNull();
    expect(parseViewport(undefined)).toBeNull();
  });
});

describe('screensFromMetadata', () => {
  it('accepts a list of ids and names them readably', () => {
    expect(screensFromMetadata({ screens: ['phone-mission', 'desktop-home'] })).toEqual([
      { id: 'phone-mission', name: 'Phone mission', viewport: null },
      { id: 'desktop-home', name: 'Desktop home', viewport: null },
    ]);
  });
  it('accepts objects with a name and a viewport', () => {
    expect(screensFromMetadata({ screens: [{ id: 'cart', name: 'Cart', viewport: '390x844' }, { id: 'x' }] })).toEqual([
      { id: 'cart', name: 'Cart', viewport: { width: 390, height: 844 } },
      { id: 'x', name: 'X', viewport: null },
    ]);
  });
  it('drops entries without an id and tolerates a missing list', () => {
    expect(screensFromMetadata({ screens: [{ name: 'no id' }, 42, ''] })).toEqual([]);
    expect(screensFromMetadata({})).toEqual([]);
    expect(screensFromMetadata(null)).toEqual([]);
  });
});

describe('screensFromHtml', () => {
  it('reads data-screen sections with their viewport and optional name, in document order', () => {
    expect(screensFromHtml(html)).toEqual([
      { id: 'phone-mission', name: 'Mission (phone)', viewport: { width: 390, height: 844 } },
      { id: 'desktop-mission', name: 'Desktop mission', viewport: { width: 1440, height: 900 } },
      { id: 'coverage', name: 'Coverage', viewport: null },
    ]);
  });
  it('never evaluates the document: a script tag is just text', () => {
    expect(screensFromHtml('<script>globalThis.__pwned = 1</script><section data-screen="a"></section>')).toHaveLength(1);
    expect((globalThis as { __pwned?: number }).__pwned).toBeUndefined();
  });
});

describe('resolveDesignScreens', () => {
  it('keeps metadata order and names, and fills viewports from the HTML', () => {
    const screens = resolveDesignScreens({ screens: ['desktop-mission', 'phone-mission'] }, html);
    expect(screens.map((s) => s.id)).toEqual(['desktop-mission', 'phone-mission']);
    expect(screens[0].viewport).toEqual({ width: 1440, height: 900 });
    expect(screens[1].name).toBe('Mission (phone)');
  });
  it('falls back to the HTML sections when metadata lists none', () => {
    expect(resolveDesignScreens({ kind: 'design' }, html).map((s) => s.id)).toEqual(['phone-mission', 'desktop-mission', 'coverage']);
  });
  it('guesses a phone or desktop viewport from the id when nothing states one', () => {
    const screens = resolveDesignScreens({ screens: ['phone-task', 'desktop-home', 'coverage'] }, null);
    expect(screens[0].viewport).toEqual(inferViewport('phone-task'));
    expect(screens[0].viewport?.width).toBe(390);
    expect(screens[1].viewport?.width).toBeGreaterThan(1000);
    expect(screens[2].viewport).toBeNull();
  });
  it('a viewport stated in metadata wins over the HTML', () => {
    const screens = resolveDesignScreens({ screens: [{ id: 'phone-mission', viewport: '360x780' }] }, html);
    expect(screens[0].viewport).toEqual({ width: 360, height: 780 });
  });
});

describe('links and sizing', () => {
  it('builds the deep link with the screen and the pinned revision', () => {
    expect(designPreviewHref('a1', { screen: 'desktop-mission', revision: 3 })).toBe('/app/artifacts/a1?screen=desktop-mission&revision=3');
    expect(designPreviewHref('a1', { screen: 'with space' })).toBe('/app/artifacts/a1?screen=with+space');
    expect(designPreviewHref('a1', {})).toBe('/app/artifacts/a1');
  });
  it('puts the screen id in the fragment of the signed URL, after its query string', () => {
    const signed = 'https://storage.example/bucket/k.html?X-Amz-Signature=abc';
    expect(frameSrc(signed, 'desktop-mission')).toBe(`${signed}#desktop-mission`);
    expect(frameSrc(signed, 'a b')).toBe(`${signed}#a%20b`);
    expect(frameSrc(signed, null)).toBe(signed);
  });
  it('scales down to fit the column and never up', () => {
    expect(fitScale(1440, 360)).toBeCloseTo(0.25);
    expect(fitScale(390, 390)).toBe(1);
    expect(fitScale(390, 1200)).toBe(1);
    expect(fitScale(390, 0)).toBe(1);
  });
});
