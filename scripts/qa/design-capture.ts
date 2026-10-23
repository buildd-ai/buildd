/**
 * Design capture — render each design screen a spec criterion names, at the
 * screen's own viewport, next to the page captures, and compose design | built.
 *
 *   QA_DESIGN=<plan JSON or path> QA_OUTPUT=/tmp/qa bun scripts/qa/design-capture.ts
 *
 * Writes, beside screenshots/ and captures.json:
 *   designs/<screen-id>.png              the screen, as drawn
 *   side-by-side/<capture>--<screen>.png design | built, one image a person can read
 *   design-captures.json                 shots, pairs (route ↔ screen), unmatched screens;
 *                                        `judge.ts prepare` reads it
 *
 * The plan is described in ./design.ts. capture.ts runs the same step in its
 * own browser when QA_DESIGN is set (local recipe); a worker that dispatched
 * visual-qa.yml runs this script over the downloaded qa-screenshots folder.
 *
 * The design is untrusted HTML. It is fetched to memory (a signed URL without
 * credentials, or a local file), then served from an origin that never
 * resolves (https://design.invalid) in a fresh browser context per screen: no
 * cookies, no storage state, no extra headers, service workers blocked. Every
 * request but the design document itself, inline data and web fonts is
 * aborted, so it reaches neither buildd nor the network, and never file://.
 *
 * Env vars:
 *   QA_DESIGN    the plan (required)
 *   QA_OUTPUT    the capture folder (default /tmp/qa)
 *   QA_VIEWPORT  what the page shots were taken at, for a captures.json that
 *                does not record it ("mobile", "desktop", WIDTHxHEIGHT)
 *
 * Exit 6: a named screen is missing from the file or has no size. Every other
 * screen is still written first.
 */

import { createHash } from 'crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { basename, join, resolve } from 'path';
import type { Browser, BrowserContextOptions } from 'playwright';
import { resolveViewport } from './viewport';
import {
  designScreensFromHtml,
  mapRoutesToScreens,
  parseDesignPlan,
  screensToCapture,
  type DesignPair,
  type DesignPlan,
  type PairableCapture,
  type ScreenToCapture,
  type Viewport,
} from './design';

export const DESIGN_ORIGIN = 'https://design.invalid';
const FONT_HOSTS = new Set(['fonts.googleapis.com', 'fonts.gstatic.com']);
const MAX_DESIGN_BYTES = 10 * 1024 * 1024;
const CSP = "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src data: https://fonts.gstatic.com; img-src data: blob:; form-action 'none'; base-uri 'none'";

type BrowserLike = Pick<Browser, 'newContext'>;

export interface DesignShot {
  screen: string;
  /** Relative to QA_OUTPUT. Absent when the screen could not be shot. */
  file?: string;
  viewport: Viewport | null;
  theme: string | null;
  /** The artifact viewer at this screen and revision, for a person to open. */
  href?: string;
  blockedRequests?: number;
  error?: 'screen_not_found' | 'no_viewport' | 'render_failed';
  detail?: string;
}

export interface DesignCaptures {
  design: { artifactId?: string; revision?: number; sha256: string; source: 'file' | 'url' };
  criteria: DesignPlan['criteria'];
  shots: DesignShot[];
  pairs: Array<DesignPair & { designImage?: string; builtImage?: string; sideBySide?: string }>;
  unmatchedScreens: string[];
}

/** What a design's page may load: itself, inline data, web fonts. Nothing else. */
export function isAllowedDesignRequest(url: string, method: string, resourceType: string, designUrl: string): boolean {
  if (url.startsWith('data:') || url.startsWith('blob:')) return true;
  if (method !== 'GET') return false;
  if (url.split('#')[0] === designUrl.split('#')[0]) return resourceType === 'document';
  let host = '';
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return false;
    host = u.hostname;
  } catch {
    return false;
  }
  return FONT_HOSTS.has(host) && (resourceType === 'stylesheet' || resourceType === 'font');
}

/** Read the design: a local file, or a signed URL fetched with no credentials. */
export async function fetchDesign(
  src: { file?: string; url?: string; sha256?: string },
  fetcher: typeof fetch = fetch,
): Promise<{ html: string; file: string; sha256: string; name: string }> {
  let bytes: Buffer;
  let file: string;
  let name: string;
  if (src.file) {
    file = resolve(src.file);
    bytes = readFileSync(file);
    name = basename(file);
  } else if (src.url) {
    const res = await fetcher(src.url, { credentials: 'omit', redirect: 'error' } as RequestInit);
    if (!res.ok) throw new Error(`design download failed: HTTP ${res.status}`);
    bytes = Buffer.from(await res.arrayBuffer());
    name = basename(new URL(src.url).pathname) || 'design.html';
    file = join(mkdtempSync(join(tmpdir(), 'qa-design-')), name);
    writeFileSync(file, bytes, { mode: 0o600 });
  } else {
    throw new Error('design needs a file or a url');
  }
  if (bytes.length > MAX_DESIGN_BYTES) throw new Error(`design is over ${MAX_DESIGN_BYTES} bytes`);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (src.sha256 && src.sha256 !== sha256) throw new Error(`design sha256 is ${sha256}, the plan pins ${src.sha256}`);
  return { html: bytes.toString('utf8'), file, sha256, name: /^[\w.-]+\.html?$/i.test(name) ? name : 'design.html' };
}

function contextFor(viewport: Viewport, theme: string | null): BrowserContextOptions {
  // The same sizing as a page shot (viewport.ts): a phone screen is a touch phone at 3x.
  const options: BrowserContextOptions = { ...resolveViewport(`${viewport.width}x${viewport.height}`), serviceWorkers: 'block', acceptDownloads: false };
  if (theme === 'light' || theme === 'dark') options.colorScheme = theme;
  return options;
}

export async function captureDesignScreens(
  browser: BrowserLike,
  opts: { file: string; html?: string; screens: readonly ScreenToCapture[]; outDir: string; name?: string },
): Promise<DesignShot[]> {
  const html = opts.html ?? readFileSync(opts.file, 'utf8');
  const designUrl = `${DESIGN_ORIGIN}/${opts.name ?? basename(opts.file)}`;
  mkdirSync(join(opts.outDir, 'designs'), { recursive: true });
  const shots: DesignShot[] = [];
  for (const s of opts.screens) {
    const base = { screen: s.id, viewport: s.viewport, theme: s.theme };
    if (!s.viewport) {
      shots.push({ ...base, error: 'no_viewport', detail: 'no data-viewport on the section and no phone-/desktop- prefix' });
      continue;
    }
    const context = await browser.newContext(contextFor(s.viewport, s.theme));
    let blocked = 0;
    try {
      await context.route('**/*', async (route) => {
        const req = route.request();
        if (req.url().split('#')[0] === designUrl && req.method() === 'GET') {
          return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', headers: { 'content-security-policy': CSP }, body: html });
        }
        if (isAllowedDesignRequest(req.url(), req.method(), req.resourceType(), designUrl)) return route.continue();
        blocked++;
        return route.abort('blockedbyclient');
      });
      const page = await context.newPage();
      await page.goto(`${designUrl}#${encodeURIComponent(s.id)}`, { waitUntil: 'load', timeout: 30_000 });
      await page.evaluate(() => (document as any).fonts?.ready).catch(() => undefined);
      await page.waitForTimeout(250);
      const section = page.locator(`section[data-screen="${s.id}"]`).first();
      if ((await section.count()) === 0) {
        shots.push({ ...base, error: 'screen_not_found', detail: `no section[data-screen="${s.id}"] in the file`, blockedRequests: blocked });
        continue;
      }
      const file = `designs/${s.id}.png`;
      const path = join(opts.outDir, file);
      // The section is the screen at its size; a router that hides it falls back to the viewport.
      if (await section.isVisible()) await section.screenshot({ path });
      else await page.screenshot({ path });
      shots.push({ ...base, file, blockedRequests: blocked });
    } catch (err) {
      shots.push({ ...base, error: 'render_failed', detail: (err as Error).message.split('\n')[0].slice(0, 300), blockedRequests: blocked });
    } finally {
      await context.close();
    }
  }
  return shots;
}

export interface ComposePair {
  captureId: string;
  route: string;
  screen: string;
  criteria: string[];
  designImage: string;
  builtImage: string;
  designViewport: Viewport | null;
  builtViewport: Viewport | null;
  /** Who drew it, e.g. `6356e80d r1`. */
  label?: string;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const dataUrl = (path: string) => `data:image/png;base64,${readFileSync(path).toString('base64')}`;

/** One image per pair: the design on the left, the built page on the right, each at its CSS width. */
export async function composeSideBySide(browser: BrowserLike, pairs: readonly ComposePair[], outDir: string): Promise<string[]> {
  mkdirSync(join(outDir, 'side-by-side'), { recursive: true });
  const written: string[] = [];
  for (const p of pairs) {
    const dw = p.designViewport?.width ?? 390;
    const bw = p.builtViewport?.width ?? dw;
    const context = await browser.newContext({ viewport: { width: dw + bw + 72, height: 600 }, deviceScaleFactor: 2, javaScriptEnabled: false });
    try {
      await context.route('**/*', (route) => (route.request().url().startsWith('data:') ? route.continue() : route.abort('blockedbyclient')));
      const page = await context.newPage();
      const figure = (title: string, img: string, width: number) =>
        `<figure><figcaption>${esc(title)}</figcaption><img src="${dataUrl(img)}" style="width:${width}px"></figure>`;
      await page.setContent(`<!doctype html><html><head><style>
        body{margin:0;padding:16px;background:#e9e6e1;font:13px/1.4 system-ui,sans-serif;color:#2a2522;display:flex;gap:24px;align-items:flex-start}
        figure{margin:0} figcaption{margin:0 0 8px;font-weight:600} img{display:block;outline:1px solid rgba(0,0,0,.2)}
      </style></head><body>
        ${figure(`Design · ${p.screen}${p.label ? ` · ${p.label}` : ''}${p.criteria.length ? ` · ${p.criteria.join(', ')}` : ''}`, p.designImage, dw)}
        ${figure(`Built · ${p.route}`, p.builtImage, bw)}
      </body></html>`, { waitUntil: 'load' });
      const file = `side-by-side/${p.captureId}--${p.screen}.png`;
      await page.screenshot({ path: join(outDir, file), fullPage: true });
      written.push(file);
    } finally {
      await context.close();
    }
  }
  return written;
}

/** The artifact viewer's deep link (apps/web/src/lib/design-preview.ts designPreviewHref). */
export function designHref(artifactId: string, screen: string, revision?: number): string {
  const q = new URLSearchParams({ screen });
  if (revision) q.set('revision', String(revision));
  return `/app/artifacts/${artifactId}?${q}`;
}

export async function runDesignCapture(opts: {
  browser: BrowserLike;
  outDir: string;
  planText: string;
  fallbackViewport?: Viewport | null;
  captures?: readonly PairableCapture[];
}): Promise<DesignCaptures> {
  const plan = parseDesignPlan(opts.planText);
  const design = await fetchDesign(plan.design);
  const inFile = designScreensFromHtml(design.html);
  const screens = screensToCapture(plan, inFile);

  const shots = (await captureDesignScreens(opts.browser, { file: design.file, html: design.html, screens, outDir: opts.outDir, name: design.name }))
    .map((s) => (plan.design.artifactId ? { ...s, href: designHref(plan.design.artifactId, s.screen, plan.design.revision) } : s));

  const capturesPath = join(opts.outDir, 'captures.json');
  const captures = opts.captures ?? (existsSync(capturesPath) ? (JSON.parse(readFileSync(capturesPath, 'utf8')) as PairableCapture[]) : []);
  const { pairs, unmatchedScreens } = mapRoutesToScreens(plan, inFile, captures, { fallbackViewport: opts.fallbackViewport });

  const label = plan.design.artifactId ? `${plan.design.artifactId.slice(0, 8)}${plan.design.revision ? ` r${plan.design.revision}` : ''}` : undefined;
  const withImages = pairs.map((p) => {
    const shot = shots.find((s) => s.screen === p.screen && s.file);
    const cap = captures.find((c) => c.id === p.captureId);
    return { ...p, designImage: shot?.file, builtImage: cap?.screenshotFile ? `screenshots/${cap.screenshotFile}` : undefined };
  });
  const composable = withImages.filter((p) => p.designImage && p.builtImage && existsSync(join(opts.outDir, p.builtImage)));
  const composed = await composeSideBySide(opts.browser, composable.map((p) => ({
    ...p,
    designImage: join(opts.outDir, p.designImage!),
    builtImage: join(opts.outDir, p.builtImage!),
    label,
  })), opts.outDir);

  const result: DesignCaptures = {
    design: {
      ...(plan.design.artifactId ? { artifactId: plan.design.artifactId } : {}),
      ...(plan.design.revision ? { revision: plan.design.revision } : {}),
      sha256: design.sha256,
      source: plan.design.file ? 'file' : 'url',
    },
    criteria: plan.criteria,
    shots,
    pairs: withImages.map((p) => {
      const sbs = `side-by-side/${p.captureId}--${p.screen}.png`;
      return composed.includes(sbs) ? { ...p, sideBySide: sbs } : p;
    }),
    unmatchedScreens,
  };
  writeFileSync(join(opts.outDir, 'design-captures.json'), JSON.stringify(result, null, 2));
  return result;
}

/**
 * The theme the named screens were drawn in: the plan's, else the first named
 * screen's `data-theme`. The page is shot in it, so the two compare like for like.
 */
export async function designTheme(planText: string): Promise<'light' | 'dark' | null> {
  const plan = parseDesignPlan(planText);
  if (plan.design.theme) return plan.design.theme;
  const { html } = await fetchDesign(plan.design);
  return screensToCapture(plan, designScreensFromHtml(html)).find((s) => s.theme)?.theme ?? null;
}

/** Read QA_DESIGN: the JSON itself when it starts with `{`, else a path to it. */
export function designPlanText(raw: string): string {
  const t = raw.trim();
  return t.startsWith('{') ? t : readFileSync(resolve(t), 'utf8');
}

if (import.meta.main) {
  const { connectReviewBrowser } = await import('./browser-provider');
  const outDir = process.env.QA_OUTPUT ?? '/tmp/qa';
  let planText: string;
  let fallbackViewport: Viewport | null = null;
  try {
    if (!process.env.QA_DESIGN?.trim()) throw new Error('QA_DESIGN is required');
    planText = designPlanText(process.env.QA_DESIGN);
    parseDesignPlan(planText);
    if (process.env.QA_VIEWPORT?.trim()) fallbackViewport = (resolveViewport(process.env.QA_VIEWPORT).viewport as Viewport) ?? null;
  } catch (err) {
    console.error(`[design] ${(err as Error).message}`);
    process.exit(1);
  }
  mkdirSync(outDir, { recursive: true });
  const { browser } = await connectReviewBrowser();
  let result: DesignCaptures;
  try {
    result = await runDesignCapture({ browser, outDir, planText: planText!, fallbackViewport });
  } catch (err) {
    console.error(`[design] ${(err as Error).message}`);
    await browser.close();
    process.exit(1);
  }
  await browser.close();
  for (const s of result!.shots) console.log(s.error ? `[design] MISS  ${s.screen}: ${s.error}` : `[design] OK    ${s.screen} → ${s.file}${s.blockedRequests ? ` (${s.blockedRequests} request(s) blocked)` : ''}`);
  for (const p of result!.pairs) console.log(`[design] PAIR  ${p.captureId} ↔ ${p.screen}${p.sideBySide ? ` → ${p.sideBySide}` : ''}${p.themeMismatch ? ' [other theme: layout and words only]' : ''}`);
  for (const s of result!.unmatchedScreens) console.log(`[design] NONE  ${s}: no capture of its route at its width (set routes.${s} in QA_DESIGN, or capture it)`);
  if (result!.shots.some((s) => s.error)) process.exit(6);
}
