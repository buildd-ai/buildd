import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { captureDesignScreens, composeSideBySide, fetchDesign, isAllowedDesignRequest, runDesignCapture } from './design-capture';

/** A Playwright-shaped browser that records what each context was given and asked. */
function fakeBrowser(opts: { missing?: string[] } = {}) {
  const contexts: Array<{ options: any; routes: number; gotos: string[]; shots: string[]; closed: boolean; content?: string }> = [];
  const browser = {
    async newContext(options: any) {
      const rec = { options, routes: 0, gotos: [] as string[], shots: [] as string[], closed: false, content: undefined as string | undefined };
      contexts.push(rec);
      const page = {
        async goto(url: string) { rec.gotos.push(url); return null; },
        async setContent(html: string) { rec.content = html; },
        async evaluate() { return undefined; },
        async waitForTimeout() {},
        locator(sel: string) {
          const id = /data-screen="([^"]+)"/.exec(sel)?.[1] ?? '';
          const present = !(opts.missing ?? []).includes(id);
          return {
            first() { return this; },
            async count() { return present ? 1 : 0; },
            async isVisible() { return present; },
            async screenshot({ path }: { path: string }) { rec.shots.push(path); writeFileSync(path, 'png'); },
          };
        },
        async screenshot({ path }: { path: string }) { rec.shots.push(path); writeFileSync(path, 'png'); },
      };
      return {
        async route() { rec.routes++; },
        async newPage() { return page; },
        async close() { rec.closed = true; },
      };
    },
  };
  return { browser, contexts };
}

const SCREENS = [
  { id: 'phone-mission', viewport: { width: 390, height: 844 }, theme: 'light' as const, inFile: true },
  { id: 'desktop-mission', viewport: { width: 1440, height: 900 }, theme: 'light' as const, inFile: true },
];

describe('captureDesignScreens', () => {
  test('renders each screen at #<id> at its own viewport, in a fresh context with no cookies, headers or storage', async () => {
    const out = mkdtempSync(join(tmpdir(), 'design-cap-'));
    try {
      const { browser, contexts } = fakeBrowser();
      const shots = await captureDesignScreens(browser as any, { file: '/tmp/d/design.html', html: '<section data-screen="phone-mission">', screens: SCREENS, outDir: out });
      expect(contexts).toHaveLength(2);
      expect(contexts[0].options).toMatchObject({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, colorScheme: 'light' });
      expect(contexts[1].options).toMatchObject({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
      for (const c of contexts) {
        expect(c.options.storageState).toBeUndefined();
        expect(c.options.extraHTTPHeaders).toBeUndefined();
        expect(c.options.serviceWorkers).toBe('block');
        expect(c.routes).toBe(1); // every request goes through the allowlist
        expect(c.closed).toBe(true);
      }
      // Served from memory on an origin that never resolves: never file://, so the design cannot frame a local file.
      expect(contexts.map((c) => c.gotos[0])).toEqual(['https://design.invalid/design.html#phone-mission', 'https://design.invalid/design.html#desktop-mission']);
      expect(shots.map((s) => [s.screen, s.file, s.error])).toEqual([['phone-mission', 'designs/phone-mission.png', undefined], ['desktop-mission', 'designs/desktop-mission.png', undefined]]);
      expect(existsSync(join(out, 'designs', 'phone-mission.png'))).toBe(true);
    } finally { rmSync(out, { recursive: true, force: true }); }
  });

  test('a screen the file lacks, or with no size, is recorded as missing and not shot', async () => {
    const out = mkdtempSync(join(tmpdir(), 'design-cap-'));
    try {
      const { browser, contexts } = fakeBrowser({ missing: ['phone-mission'] });
      const shots = await captureDesignScreens(browser as any, {
        file: '/tmp/d/design.html', html: '',
        screens: [SCREENS[0], { id: 'coverage', viewport: null, theme: null, inFile: true }],
        outDir: out,
      });
      expect(shots.map((s) => [s.screen, s.error])).toEqual([['phone-mission', 'screen_not_found'], ['coverage', 'no_viewport']]);
      expect(contexts.flatMap((c) => c.shots)).toEqual([]);
    } finally { rmSync(out, { recursive: true, force: true }); }
  });
});

describe('isAllowedDesignRequest', () => {
  test('the design file, inline data and web fonts load; anything else, buildd included, is refused', () => {
    const allow = (url: string, method: string, type: string) => isAllowedDesignRequest(url, method, type, 'https://design.invalid/design.html');
    expect(allow('https://design.invalid/design.html', 'GET', 'document')).toBe(true);
    expect(allow('https://design.invalid/other.js', 'GET', 'script')).toBe(false);
    expect(allow('data:image/png;base64,AA', 'GET', 'image')).toBe(true);
    expect(allow('https://fonts.googleapis.com/css2?family=Inter', 'GET', 'stylesheet')).toBe(true);
    expect(allow('https://fonts.gstatic.com/s/inter.woff2', 'GET', 'font')).toBe(true);
    expect(allow('https://fonts.gstatic.com/s/inter.woff2', 'POST', 'fetch')).toBe(false);
    expect(allow('http://localhost:3000/api/tasks', 'GET', 'fetch')).toBe(false);
    expect(allow('https://evil.example/beacon', 'GET', 'image')).toBe(false);
    expect(allow('file:///etc/passwd', 'GET', 'fetch')).toBe(false);
  });
});

describe('fetchDesign', () => {
  test('a local file is read; a sha256 that does not match is refused', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'design-file-'));
    try {
      const file = join(dir, 'd.html');
      writeFileSync(file, '<section data-screen="a">');
      const got = await fetchDesign({ file });
      expect(got.html).toContain('data-screen');
      expect(got.sha256).toMatch(/^[0-9a-f]{64}$/);
      await expect(fetchDesign({ file, sha256: '0'.repeat(64) })).rejects.toThrow(/sha256/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('a signed URL is downloaded without credentials to a private temp file', async () => {
    const calls: Array<{ url: string; init: any }> = [];
    const fetcher = async (url: string, init: any) => { calls.push({ url, init }); return new Response('<section data-screen="a">', { status: 200 }); };
    const got = await fetchDesign({ url: 'https://storage.example/d.html?X-Amz-Signature=s' }, fetcher as any);
    expect(calls[0].init).toMatchObject({ credentials: 'omit', redirect: 'error' });
    expect(readFileSync(got.file, 'utf8')).toContain('data-screen');
    await expect(fetchDesign({ url: 'https://storage.example/x' }, (async () => new Response('', { status: 403 })) as any)).rejects.toThrow(/403/);
  });
});

describe('composeSideBySide', () => {
  test('writes design | built for each pair, from the two images only, with no network', async () => {
    const out = mkdtempSync(join(tmpdir(), 'design-sbs-'));
    try {
      writeFileSync(join(out, 'design.png'), 'd');
      writeFileSync(join(out, 'built.png'), 'b');
      const { browser, contexts } = fakeBrowser();
      const files = await composeSideBySide(browser as any, [{
        captureId: 'fx', route: '/app/dev/fixtures?state=x', screen: 'phone-mission', criteria: ['AC-4'],
        designImage: join(out, 'design.png'), builtImage: join(out, 'built.png'),
        designViewport: { width: 390, height: 844 }, builtViewport: { width: 390, height: 844 }, label: '6356e80d r1',
      }], out);
      expect(files).toEqual(['side-by-side/fx--phone-mission.png']);
      expect(contexts[0].routes).toBe(1);
      expect(contexts[0].content).toContain('Design · phone-mission');
      expect(contexts[0].content).toContain('Built ·');
      expect(contexts[0].content).toContain('data:image/png;base64,');
      expect(contexts[0].content).not.toContain('<script');
    } finally { rmSync(out, { recursive: true, force: true }); }
  });
});

describe('runDesignCapture', () => {
  test('captures the named screens, pairs them with captures.json and writes design-captures.json', async () => {
    const out = mkdtempSync(join(tmpdir(), 'design-run-'));
    try {
      const file = join(out, 'design.html');
      writeFileSync(file, '<section data-screen="phone-mission" data-viewport="390x844" data-theme="light"></section><section data-screen="desktop-mission" data-viewport="1440x900"></section>');
      const { mkdirSync } = await import('fs');
      mkdirSync(join(out, 'screenshots'), { recursive: true });
      writeFileSync(join(out, 'screenshots', 'fx.png'), 'b');
      writeFileSync(join(out, 'captures.json'), JSON.stringify([{ id: 'fx', path: '/app/dev/fixtures?state=x', screenshotFile: 'fx.png', viewport: { width: 390, height: 844 }, theme: 'light' }]));
      const { browser } = fakeBrowser();
      const result = await runDesignCapture({
        browser: browser as any,
        outDir: out,
        planText: JSON.stringify({ design: { file, artifactId: 'art-1', revision: 2 }, criteria: [{ id: 'AC-4', text: 'Mission page', screens: ['phone-mission', 'desktop-mission'] }], routes: { 'phone-mission': '/app/dev/fixtures?state=x' } }),
      });
      const written = JSON.parse(readFileSync(join(out, 'design-captures.json'), 'utf8'));
      expect(written).toEqual(result);
      expect(written.design).toMatchObject({ artifactId: 'art-1', revision: 2 });
      expect(written.shots.map((s: any) => [s.screen, s.href])).toEqual([
        ['phone-mission', '/app/artifacts/art-1?screen=phone-mission&revision=2'],
        ['desktop-mission', '/app/artifacts/art-1?screen=desktop-mission&revision=2'],
      ]);
      expect(written.pairs).toEqual([expect.objectContaining({ captureId: 'fx', screen: 'phone-mission', sideBySide: 'side-by-side/fx--phone-mission.png' })]);
      expect(written.unmatchedScreens).toEqual(['desktop-mission']);
      expect(written.criteria).toEqual([{ id: 'AC-4', text: 'Mission page', screens: ['phone-mission', 'desktop-mission'] }]);
    } finally { rmSync(out, { recursive: true, force: true }); }
  });
});
