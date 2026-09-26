/**
 * run-storyboard.ts — drive the real dashboard through a storyboard and capture it.
 *
 *   bun run scripts/demo/run-storyboard.ts <storyboard.yaml> [--out <dir>] [--themes dark,light] [--no-seed] [--only step1,step2] [--no-record]
 *
 * Prereqs: scripts/demo/up.sh (containers + migrations) and scripts/demo/serve.sh --bg.
 *
 * Storyboard YAML:
 *
 *   story: ../stories/multi-currency.json   # dataset (relative to this file); env DEMO_STORY overrides
 *   viewport: { width: 1440, height: 900, scale: 2 }   # the "desktop" viewport
 *   viewports: { phone: { width: 390, height: 844, scale: 3 } }   # optional; phone is built in
 *   themes: [dark, light]
 *   highlight: [goal-band, board-tile]  # optional: boxes recorded on EVERY shot where present (silent when absent)
 *   steps:
 *     - id: mission-mid-flight
 *       advance: "11:46"              # replay the timeline to t (seconds | mm:ss | end)
 *       goto: /app/missions/{M1}      # {key} = the seeded UUID of dataset key "M1"
 *       viewports: [desktop, phone]   # default [desktop]
 *       waitFor: mission-detail       # data-testid (or `text=…` / any Playwright selector)
 *       click: mission-task-row       # optional: testid/selector to click before the shot
 *       scrollTo: mission-feed        # optional: testid/selector to scroll into view
 *       scrollAlign: end              # optional: bring it to the bottom edge (default start = top edge)
 *       highlight: [mission-pulse, mission-task-row]   # bounding boxes → manifest.json (warned when missing)
 *       caption: "Six agents. Four machines. At the same time."
 *       fullPage: false               # default: viewport-sized shot
 *       hold: 500                     # ms to settle after load (default 400)
 *       record: { ms: 8000, advanceTo: "14:30", ticks: 6 }   # optional webm: live replay via Pusher
 *
 * Output: <out>/<story>/<step>-<theme>.png (desktop) or <step>-<viewport>-<theme>.png,
 * .webm for record steps, and <out>/<story>/manifest.json with captions, element
 * boxes (CSS px, plus each element's data-status/state/kind) and timings.
 *
 * The browser clock is frozen at "story now" for every shot (page.clock), the
 * Next dev overlay/route announcer are hidden, and animations are settled, so a
 * re-run produces the same frames.
 */
import { DEMO } from './lib/guard';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { createLocalDb } from '../../packages/core/db/local-client';
import { loadState, loadStory, type DemoState } from './lib/story';
import { seedStory } from './seed';
import { advanceTo, parseT } from './advance';
import { mintSessionToken, SESSION_COOKIE } from './lib/session';
import { captureFile, captureKey, DESKTOP, highlightTargets, isRendered, resolveViewports, scrollPlan, stepViewports, type Viewport, type ViewportSpec } from './lib/storyboard';

type Step = {
  id: string;
  goto?: string;
  advance?: string | number;
  viewports?: string[];
  waitFor?: string | string[];
  click?: string;
  scrollTo?: string;
  scrollOffset?: number;
  scrollAlign?: 'start' | 'end';
  highlight?: string[];
  caption?: string;
  fullPage?: boolean;
  hold?: number;
  shot?: boolean;
  record?: { ms?: number; advanceTo?: string | number; ticks?: number; theme?: 'dark' | 'light'; viewport?: string };
};
type Storyboard = {
  story?: string;
  name?: string;
  viewport?: ViewportSpec;
  viewports?: Record<string, ViewportSpec>;
  themes?: Array<'dark' | 'light'>;
  highlight?: string[];
  steps: Step[];
};
type Theme = 'dark' | 'light';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

const HIDE_CSS = `
  nextjs-portal, [data-nextjs-toast], #__next-build-watcher, next-route-announcer { display: none !important; }
  * { caret-color: transparent !important; }
  ::-webkit-scrollbar { display: none; }
`;

/** A bare word is a data-testid; anything else is a Playwright selector. */
function sel(target: string): string {
  return /^[a-z0-9][a-z0-9-_]*$/i.test(target) ? `[data-testid="${target}"]` : target;
}

function fill(path: string, ids: Record<string, string>): string {
  return path.replace(/\{([^}]+)\}/g, (m, key) => {
    if (!ids[key]) throw new Error(`[storyboard] unknown dataset key {${key}} in "${path}"`);
    return ids[key];
  });
}

async function main() {
  const boardPath = process.argv[2];
  if (!boardPath || boardPath.startsWith('--')) {
    console.error('usage: bun run scripts/demo/run-storyboard.ts <storyboard.yaml> [--out dir] [--themes dark,light] [--no-seed] [--only a,b] [--no-record]');
    process.exit(1);
  }
  const board = Bun.YAML.parse(readFileSync(boardPath, 'utf8')) as Storyboard;
  const storyPath = process.env.DEMO_STORY ?? (board.story ? resolve(dirname(resolve(boardPath)), board.story) : undefined);
  if (!storyPath || !existsSync(storyPath)) throw new Error(`[storyboard] story dataset not found: ${storyPath}`);
  const { story, name: storyName, path: storyAbs } = loadStory(storyPath);
  const outRoot = resolve(arg('out') ?? join(import.meta.dir, 'out'));
  const outDir = join(outRoot, board.name ?? storyName);
  mkdirSync(outDir, { recursive: true });
  const themes = (arg('themes')?.split(',') as Theme[]) ?? board.themes ?? ['dark', 'light'];
  const only = arg('only')?.split(',');
  const noRecord = process.argv.includes('--no-record');
  const viewports = resolveViewports(board);
  // Validate every step's viewports up front, before minutes of shooting.
  for (const step of board.steps) stepViewports(step, viewports);

  const db = createLocalDb();
  if (!process.argv.includes('--no-seed')) {
    console.log(`[storyboard] seeding "${storyName}"`);
    await seedStory(db, story, storyName, storyAbs);
  }
  let state: DemoState = await loadState(db);
  const userKey = story.users?.[0]?.key;
  const token = await mintSessionToken({ id: state.ids[userKey], email: story.users[0].email, name: story.users[0].name });
  const teamId = state.ids[story.team.key];

  const browser: Browser = await chromium.launch({ headless: true });
  const base = new URL(DEMO.baseUrl);

  async function newContext(theme: Theme, vp: Viewport, extra: Parameters<Browser['newContext']>[0] = {}): Promise<BrowserContext> {
    const ctx = await browser.newContext({
      viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: vp.scale, colorScheme: theme,
      isMobile: !!vp.mobile, hasTouch: !!vp.mobile, locale: 'en-US', timezoneId: story.team?.timezone ?? 'UTC', ...extra,
    });
    await ctx.addCookies([
      { name: SESSION_COOKIE, value: token, domain: base.hostname, path: '/', httpOnly: true, sameSite: 'Lax' },
      { name: 'buildd-team', value: teamId, domain: base.hostname, path: '/', sameSite: 'Lax' },
    ]);
    await ctx.addInitScript((t) => { try { localStorage.setItem('buildd-theme', t); } catch {} }, theme);
    return ctx;
  }

  // One long-lived page per (viewport, theme), opened lazily.
  const pages = new Map<string, Page>();
  async function pageFor(vpName: string, theme: Theme): Promise<Page> {
    const key = captureKey(vpName, theme);
    let page = pages.get(key);
    if (!page) {
      page = await (await newContext(theme, viewports[vpName])).newPage();
      page.on('pageerror', (err) => console.warn(`[storyboard] page error (${key}): ${err.message}`));
      pages.set(key, page);
    }
    return page;
  }

  async function prepare(page: Page, step: Step, opts: { freezeClock?: boolean } = {}) {
    // Stills freeze the page clock at "story now" for reproducible frames. Live
    // takes must NOT: the pages' realtime throttles schedule off Date.now, and a
    // frozen clock turns them into debounces that never fire under steady pushes.
    if (opts.freezeClock !== false) await page.clock.setFixedTime(new Date());
    const url = DEMO.baseUrl + fill(step.goto ?? new URL(page.url()).pathname, state.ids);
    await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 });
    await page.addStyleTag({ content: HIDE_CSS });
    const missing: string[] = [];
    for (const w of [step.waitFor ?? []].flat()) {
      try {
        await page.waitForSelector(sel(w), { timeout: 15_000 });
      } catch {
        missing.push(w);
        console.warn(`[storyboard]   waitFor "${w}" never appeared on ${page.url()}`);
        if (process.argv.includes('--strict')) throw new Error(`waitFor "${w}" missing (--strict)`);
      }
    }
    if (step.click) {
      await page.locator(sel(step.click)).first().click();
      await page.waitForLoadState('networkidle');
    }
    // Let the page settle first — some pages auto-scroll on mount (e.g. a
    // scrollIntoView on the selected pulse segment) — then start every shot at
    // the top, and optionally bring a target to the top edge.
    await page.waitForTimeout(step.hold ?? 400);
    await page.evaluate(() => {
      window.scrollTo(0, 0);
      for (const el of Array.from(document.querySelectorAll<HTMLElement>('*'))) if (el.scrollTop > 0) el.scrollTop = 0;
    });
    if (step.scrollTo && (await page.locator(sel(step.scrollTo)).count())) {
      await page.locator(sel(step.scrollTo)).first().evaluate((el, { block, delta }) => {
        el.scrollIntoView({ block });
        // Leave room for sticky headers (start) or below the target (end).
        let p: HTMLElement | null = el.parentElement;
        while (p && p !== document.body) {
          if (p.scrollHeight > p.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(p).overflowY)) { p.scrollTop += delta; return; }
          p = p.parentElement;
        }
        window.scrollBy(0, delta);
      }, scrollPlan(step));
    }
    await page.waitForTimeout(150);
    return missing;
  }

  async function boxes(page: Page, step: Step) {
    const out = [];
    for (const { target, required } of highlightTargets(step, board.highlight)) {
      const loc = page.locator(sel(target));
      const n = await loc.count();
      if (!n && !required) continue;
      const found = [];
      for (let i = 0; i < Math.min(n, 40); i++) {
        const el = loc.nth(i);
        const b = await el.boundingBox();
        if (!b || b.width <= 0 || b.height <= 0) continue;
        if (!(await el.evaluate(isRendered))) continue;
        const attrs = await el.evaluate((node) => {
          const o: Record<string, string> = {};
          for (const a of ['data-status', 'data-state', 'data-kind', 'data-phase']) {
            const v = node.getAttribute(a);
            if (v != null) o[a.slice(5)] = v;
          }
          const text = (node.textContent ?? '').replace(/\s+/g, ' ').trim();
          if (text) o.text = text.slice(0, 80);
          return o;
        });
        found.push({ x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height), ...attrs });
      }
      if (!found.length && required) console.warn(`[storyboard]   highlight "${target}" not found/visible`);
      out.push({ target, selector: sel(target), count: n, boxes: found });
    }
    return out;
  }

  async function unclip(page: Page) {
    // The app scrolls inside <main>, not the window, so fullPage alone stops
    // at the viewport: unclip inner scroll containers (as scripts/qa/capture.ts does).
    await page.evaluate(() => {
      for (const el of Array.from(document.querySelectorAll<HTMLElement>('body *'))) {
        const style = getComputedStyle(el);
        if (/(auto|scroll)/.test(style.overflowY) && el.scrollHeight > el.clientHeight + 1) {
          for (let n: HTMLElement | null = el; n && n !== document.body; n = n.parentElement) {
            n.style.setProperty('height', 'auto', 'important');
            n.style.setProperty('max-height', 'none', 'important');
            n.style.setProperty('overflow', 'visible', 'important');
          }
        }
      }
    });
  }

  const manifest: any = {
    story: storyName, storyboard: resolve(boardPath), generatedAt: new Date().toISOString(),
    viewports, viewport: { width: viewports[DESKTOP].width, height: viewports[DESKTOP].height, deviceScaleFactor: viewports[DESKTOP].scale },
    themes, steps: [] as any[],
  };
  const t0 = Date.now();

  for (const step of board.steps) {
    if (only && !only.includes(step.id)) continue;
    const started = Date.now();
    let advanceMs = 0;
    if (step.advance !== undefined) {
      const a = Date.now();
      await advanceTo(db, parseT(String(step.advance), story), { quiet: true });
      state = await loadState(db);
      advanceMs = Date.now() - a;
    }
    const entry: any = {
      id: step.id, caption: step.caption ?? null, t: state.appliedT, path: step.goto ? fill(step.goto, state.ids) : null,
      files: {}, highlights: {}, timings: { offsetMs: started - t0, advanceMs },
    };
    // `shot: false` steps exist only for their live take.
    for (const vpName of step.shot === false ? [] : stepViewports(step, viewports)) {
      for (const theme of themes) {
        const key = captureKey(vpName, theme);
        const page = await pageFor(vpName, theme);
        // Re-anchor "story now" to the wall clock before every capture, so a
        // shot taken 30s after its step's advance still reads t (not t+30s).
        await advanceTo(db, state.appliedT, { quiet: true });
        const l = Date.now();
        const missing = await prepare(page, step);
        if (missing.length) (entry.waitForMissing ??= {})[key] = missing;
        entry.timings[`${key}LoadMs`] = Date.now() - l;
        if (step.fullPage) await unclip(page);
        entry.highlights[key] = await boxes(page, step);
        if (step.shot !== false) {
          const file = captureFile(step.id, vpName, theme);
          await page.screenshot({ path: join(outDir, file), fullPage: step.fullPage ?? false, animations: 'disabled' });
          entry.files[key] = file;
        }
        entry.url = page.url().replace(DEMO.baseUrl, '');
      }
    }

    if (step.record && !noRecord) {
      // Record one live take: the page stays open while the timeline advances
      // in ticks, so realtime pushes (soketi) drive the UI.
      const theme = step.record.theme ?? themes[0];
      const vpName = step.record.viewport ?? DESKTOP;
      const vp = viewports[vpName];
      const ctx = await newContext(theme, vp, { recordVideo: { dir: outDir, size: { width: vp.width, height: vp.height } } });
      const page = await ctx.newPage();
      const recStart = Date.now();
      if (process.env.DEMO_DEBUG_RECORD) {
        page.on('request', (r) => { if (r.url().includes('_rsc') && !r.url().includes('task=')) console.log('[rec rsc]', ((Date.now() - recStart) / 1000).toFixed(1), r.url().slice(-60)); });
        page.on('websocket', (ws) => ws.on('framereceived', (f) => { const p = String(f.payload); if (!p.includes('ping') && !p.includes('pong')) console.log('[rec ws]', ((Date.now() - recStart) / 1000).toFixed(1), p.slice(0, 90)); }));
        page.on('console', (m) => console.log('[rec console]', m.text().slice(0, 150)));
      }
      await advanceTo(db, state.appliedT, { quiet: true });
      await prepare(page, step, { freezeClock: false });
      // The video starts at page creation (blank + skeleton); trim this much.
      const leadInMs = Date.now() - recStart;
      const from = state.appliedT;
      const to = step.record.advanceTo !== undefined ? parseT(String(step.record.advanceTo), story) : from;
      const ticks = Math.max(1, step.record.ticks ?? 4);
      const ms = step.record.ms ?? 6000;
      for (let i = 1; i <= ticks; i++) {
        if (to > from) await advanceTo(db, Math.round(from + ((to - from) * i) / ticks), { quiet: true });
        await page.waitForTimeout(ms / ticks);
      }
      state = await loadState(db);
      const video = page.video();
      await ctx.close();
      if (video) {
        const file = captureFile(step.id, vpName, theme, 'webm');
        renameSync(await video.path(), join(outDir, file));
        entry.files[`${captureKey(vpName, theme)}Video`] = file;
      }
      entry.record = { fromT: from, toT: state.appliedT, ms, ticks, theme, viewport: vpName, leadInMs };
    }
    entry.timings.totalMs = Date.now() - started;
    manifest.steps.push(entry);
    console.log(`[storyboard] ${step.id.padEnd(28)} t=${String(entry.t).padStart(5)}s  ${Object.values(entry.files).join(', ')}`);
  }

  writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  await browser.close();
  console.log(`[storyboard] done → ${outDir}`);
}

await main();
process.exit(0);
