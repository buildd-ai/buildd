/**
 * run-storyboard.ts — drive the real dashboard through a storyboard and capture it.
 *
 *   bun run scripts/demo/run-storyboard.ts <storyboard.yaml> [--out <dir>] [--themes dark,light] [--no-seed] [--only step1,step2]
 *
 * Prereqs: scripts/demo/up.sh (containers + migrations) and scripts/demo/serve.sh --bg.
 *
 * Storyboard YAML:
 *
 *   story: ../stories/placeholder.json   # dataset (relative to this file); env DEMO_STORY overrides
 *   viewport: { width: 1440, height: 900, scale: 2 }
 *   themes: [dark, light]
 *   steps:
 *     - id: mission-mid-flight
 *       advance: "11:46"              # replay the timeline to t (seconds | mm:ss | end)
 *       goto: /app/missions/{M1}      # {key} = the seeded UUID of dataset key "M1"
 *       waitFor: mission-detail       # data-testid (or `text=…` / any Playwright selector)
 *       click: mission-task-row       # optional: testid/selector to click before the shot
 *       scrollTo: mission-feed        # optional: testid/selector to scroll into view
 *       highlight: [mission-pulse, mission-task-row]   # bounding boxes → manifest.json
 *       caption: "Six agents. Four machines. At the same time."
 *       fullPage: false               # default: viewport-sized shot
 *       hold: 500                     # ms to settle after load (default 400)
 *       record: { ms: 8000, advanceTo: "14:30", ticks: 6 }   # optional webm: live replay via Pusher
 *
 * Output: <out>/<story>/<step>-<theme>.png (+ .webm for record steps) and
 * <out>/<story>/manifest.json with captions, element boxes (CSS px) and timings.
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

type Step = {
  id: string;
  goto?: string;
  advance?: string | number;
  waitFor?: string | string[];
  click?: string;
  scrollTo?: string;
  scrollOffset?: number;
  highlight?: string[];
  caption?: string;
  fullPage?: boolean;
  hold?: number;
  shot?: boolean;
  record?: { ms?: number; advanceTo?: string | number; ticks?: number };
};
type Storyboard = {
  story?: string;
  name?: string;
  viewport?: { width?: number; height?: number; scale?: number };
  themes?: Array<'dark' | 'light'>;
  steps: Step[];
};

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
    console.error('usage: bun run scripts/demo/run-storyboard.ts <storyboard.yaml> [--out dir] [--themes dark,light] [--no-seed] [--only a,b]');
    process.exit(1);
  }
  const board = Bun.YAML.parse(readFileSync(boardPath, 'utf8')) as Storyboard;
  const storyPath = process.env.DEMO_STORY ?? (board.story ? resolve(dirname(resolve(boardPath)), board.story) : undefined);
  if (!storyPath || !existsSync(storyPath)) throw new Error(`[storyboard] story dataset not found: ${storyPath}`);
  const { story, name: storyName, path: storyAbs } = loadStory(storyPath);
  const outRoot = resolve(arg('out') ?? join(import.meta.dir, 'out'));
  const outDir = join(outRoot, board.name ?? storyName);
  mkdirSync(outDir, { recursive: true });
  const themes = (arg('themes')?.split(',') as Array<'dark' | 'light'>) ?? board.themes ?? ['dark', 'light'];
  const only = arg('only')?.split(',');
  const vp = { width: board.viewport?.width ?? 1440, height: board.viewport?.height ?? 900 };
  const scale = board.viewport?.scale ?? 2;

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

  async function newContext(theme: 'dark' | 'light', extra: Parameters<Browser['newContext']>[0] = {}): Promise<BrowserContext> {
    const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: scale, colorScheme: theme, locale: 'en-US', timezoneId: story.team?.timezone ?? 'UTC', ...extra });
    await ctx.addCookies([
      { name: SESSION_COOKIE, value: token, domain: base.hostname, path: '/', httpOnly: true, sameSite: 'Lax' },
      { name: 'buildd-team', value: teamId, domain: base.hostname, path: '/', sameSite: 'Lax' },
    ]);
    await ctx.addInitScript((t) => { try { localStorage.setItem('buildd-theme', t); } catch {} }, theme);
    return ctx;
  }

  const pages = new Map<string, Page>();
  for (const theme of themes) {
    const ctx = await newContext(theme);
    const page = await ctx.newPage();
    page.on('pageerror', (err) => console.warn(`[storyboard] page error (${theme}): ${err.message}`));
    pages.set(theme, page);
  }

  async function prepare(page: Page, step: Step) {
    await page.clock.setFixedTime(new Date());
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
      await page.locator(sel(step.scrollTo)).first().evaluate((el, offset) => {
        el.scrollIntoView({ block: 'start' });
        // Leave room for sticky headers.
        let p: HTMLElement | null = el.parentElement;
        while (p && p !== document.body) {
          if (p.scrollHeight > p.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(p).overflowY)) { p.scrollTop -= offset; return; }
          p = p.parentElement;
        }
        window.scrollBy(0, -offset);
      }, step.scrollOffset ?? 120);
    }
    await page.waitForTimeout(150);
    return missing;
  }

  async function boxes(page: Page, targets: string[]) {
    const out = [];
    for (const target of targets) {
      const loc = page.locator(sel(target));
      const n = await loc.count();
      const found = [];
      for (let i = 0; i < Math.min(n, 20); i++) {
        const b = await loc.nth(i).boundingBox();
        if (b && b.width > 0 && b.height > 0) found.push({ x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) });
      }
      if (!found.length) console.warn(`[storyboard]   highlight "${target}" not found/visible`);
      out.push({ target, selector: sel(target), count: n, boxes: found });
    }
    return out;
  }

  const manifest: any = {
    story: storyName, storyboard: resolve(boardPath), generatedAt: new Date().toISOString(),
    viewport: { ...vp, deviceScaleFactor: scale }, themes, steps: [] as any[],
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
    for (const theme of themes) {
      const page = pages.get(theme)!;
      const l = Date.now();
      const missing = await prepare(page, step);
      if (missing.length) entry.waitForMissing = missing;
      entry.timings[`${theme}LoadMs`] = Date.now() - l;
      entry.highlights[theme] = await boxes(page, step.highlight ?? []);
      if (step.shot !== false) {
        const file = `${step.id}-${theme}.png`;
        // The app scrolls inside <main>, not the window, so fullPage alone stops
        // at the viewport: unclip inner scroll containers (as scripts/qa/capture.ts does).
        if (step.fullPage) {
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
        await page.screenshot({ path: join(outDir, file), fullPage: step.fullPage ?? false, animations: 'disabled' });
        entry.files[theme] = file;
      }
      entry.url = page.url().replace(DEMO.baseUrl, '');
    }

    if (step.record) {
      // Record one live take (first theme): the page stays open while the
      // timeline advances in ticks, so realtime pushes drive the UI.
      const theme = themes[0];
      const ctx = await newContext(theme, { recordVideo: { dir: outDir, size: vp } });
      const page = await ctx.newPage();
      await prepare(page, step);
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
        const file = `${step.id}-${theme}.webm`;
        renameSync(await video.path(), join(outDir, file));
        entry.files[`${theme}Video`] = file;
      }
      entry.record = { fromT: from, toT: state.appliedT, ms, ticks };
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
