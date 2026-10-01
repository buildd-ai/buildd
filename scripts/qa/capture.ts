/**
 * Visual QA capture — Playwright headless pass.
 *
 * Starts a headless Chromium session, authenticates, then navigates to a set of
 * routes and saves a screenshot + a11y snapshot for each. Runs anywhere headless
 * Chromium runs (local dev, Coder workspace, CI) against any reachable base URL
 * (localhost, a Cloudflare tunnel, or a Vercel preview).
 *
 * Route selection (in priority order):
 *   1. QA_ROUTES set  → capture exactly those ad-hoc paths (manifest ignored).
 *                       Best for reviewing the impact of a specific change.
 *   2. otherwise      → capture every route in the manifest. Dynamic routes
 *                       (`:id`) are resolved from QA_TASK_ID / QA_MISSION_ID when
 *                       provided, and skipped otherwise.
 *
 * Auth (in priority order):
 *   1. VISUAL_QA_STORAGE_STATE_PATH → load a pre-authenticated Playwright storage
 *                                     state (session cookie). Works against any
 *                                     deployment, no NODE_ENV=development needed.
 *   2. dev-auto-login credentials provider (only exists when NODE_ENV=development,
 *      see apps/web/src/auth.ts). Used automatically when no storage state is set.
 *
 * Env vars:
 *   QA_BASE_URL                     — base URL of the running app (default: http://localhost:3000)
 *   QA_OUTPUT                       — output dir for screenshots/a11y (default: /tmp/qa)
 *   QA_MANIFEST                     — path to visual-qa-routes.json (default: apps/web/src/qa/visual-qa-routes.json)
 *   QA_ROUTES                       — comma-separated ad-hoc paths, e.g. "/app/tasks/abc,/app/missions/xyz"
 *   QA_TASK_ID                      — resolves `/app/tasks/:id` in the manifest
 *   QA_MISSION_ID                   — resolves `/app/missions/:id` in the manifest
 *   VISUAL_QA_STORAGE_STATE_PATH    — Playwright storageState JSON for remote auth
 *   VISUAL_QA_STORAGE_STATE         — the same storageState as JSON text (a workspace secret mapped
 *                                     through gitConfig.envMapping). Written to a 0600 temp file,
 *                                     never logged.
 *   VERCEL_AUTOMATION_BYPASS_SECRET — sets the x-vercel-protection-bypass header on every request
 *   QA_PAGE_SOURCE                  — "sandbox" (default) or "vercel-preview", from get_page_source.
 *                                     Recorded on every capture as `source`. With vercel-preview the
 *                                     buildd-only dev login is skipped and auth walls are classified:
 *                                     a Vercel login wall is `protection_bypass_missing`, an uninvited
 *                                     sign-in page `app_auth_not_configured`. Either is a config error,
 *                                     not a shot, and exits 3 after the loop.
 *   QA_SIGN_IN_PATHS                — comma-separated app sign-in paths (default: /login,/signin,…)
 *   QA_NO_LOGIN                     — skip the dev-auto-login POST (dev server bypasses auth already)
 *   QA_KEEP_DEV_OVERLAY             — keep the Next.js dev error overlay in shots (default: hide it)
 *   QA_VIEWPORT                     — "mobile" (390x844 touch phone), "desktop", or WIDTHxHEIGHT (default: 1280x900)
 */

import { chromium } from 'playwright';
import type { BrowserContextOptions } from 'playwright';
import { readFileSync, mkdirSync, writeFileSync, existsSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { resolveViewport } from './viewport';
import {
  classifyPageLoad,
  CONFIG_ERROR_MESSAGES,
  type CaptureConfigError,
} from '../../packages/core/visual-qa-page-source';

// Validate QA_VIEWPORT before anything else runs (no browser launched yet, no
// swallow handlers registered yet) so a typo fails fast with a clear message
// and a non-zero exit, instead of throwing later — after the browser is up —
// where it would land in the uncaughtException handler below, get logged as a
// non-fatal warning, and leave the Capture step hanging with a live browser
// and nothing left to await.
let contextOptions: BrowserContextOptions;
try {
  contextOptions = resolveViewport(process.env.QA_VIEWPORT);
} catch (err) {
  console.error(`[capture] ${(err as Error).message}`);
  process.exit(1);
}
console.log(`[capture] viewport ${contextOptions.viewport?.width}x${contextOptions.viewport?.height}${contextOptions.isMobile ? ' (mobile, touch)' : ''}`);

// Page source and a storage state from a secret, validated before the first
// await for the same reason as QA_VIEWPORT above. The storage state's content
// is never printed, not even in the error.
const PAGE_SOURCE = process.env.QA_PAGE_SOURCE?.trim() || 'sandbox';
if (PAGE_SOURCE !== 'sandbox' && PAGE_SOURCE !== 'vercel-preview') {
  console.error(`[capture] QA_PAGE_SOURCE must be "sandbox" or "vercel-preview"`);
  process.exit(1);
}
const IS_PREVIEW = PAGE_SOURCE === 'vercel-preview';
const SIGN_IN_PATHS = (process.env.QA_SIGN_IN_PATHS ?? '').split(',').map((p) => p.trim()).filter((p) => p.startsWith('/'));
let storageStateFromSecret = '';
if (process.env.VISUAL_QA_STORAGE_STATE) {
  try {
    JSON.parse(process.env.VISUAL_QA_STORAGE_STATE);
  } catch {
    console.error('[capture] VISUAL_QA_STORAGE_STATE is not valid JSON (content not shown)');
    process.exit(1);
  }
  storageStateFromSecret = join(mkdtempSync(join(tmpdir(), 'qa-state-')), 'state.json');
  writeFileSync(storageStateFromSecret, process.env.VISUAL_QA_STORAGE_STATE, { mode: 0o600 });
}
console.log(`[capture] source ${PAGE_SOURCE}`);

// Playwright 1.61 can throw unhandled errors from internal cookie/URL handling when
// a response URL is relative. Suppress these non-fatal background exceptions so the
// process exits cleanly with the captures it managed to collect.
process.on('uncaughtException', (err: Error) => {
  console.warn('[capture] non-fatal uncaught exception (Playwright internal):', err.message);
});
process.on('unhandledRejection', (reason: unknown) => {
  const msg = (reason as Error)?.message ?? String(reason);
  console.warn('[capture] non-fatal unhandled rejection:', msg);
});

const BASE_URL = process.env.QA_BASE_URL ?? 'http://localhost:3000';
const OUTPUT_DIR = process.env.QA_OUTPUT ?? '/tmp/qa';
const MANIFEST_PATH = process.env.QA_MANIFEST ?? 'apps/web/src/qa/visual-qa-routes.json';

const STORAGE_STATE_PATH = process.env.VISUAL_QA_STORAGE_STATE_PATH || storageStateFromSecret;
const BYPASS_SECRET = process.env.VERCEL_AUTOMATION_BYPASS_SECRET ?? '';

// Known dynamic-segment resolvers: manifest path → env var holding a real ID.
const DYNAMIC_PARAMS: Record<string, string | undefined> = {
  '/app/tasks/:id': process.env.QA_TASK_ID,
  '/app/missions/:id': process.env.QA_MISSION_ID,
};

mkdirSync(join(OUTPUT_DIR, 'screenshots'), { recursive: true });
mkdirSync(join(OUTPUT_DIR, 'a11y'), { recursive: true });

// --- Build the route list ---
type Route = { id: string; path: string; skipReason?: string };

/** Turn an ad-hoc path into a filesystem-safe id, e.g. /app/tasks/abc → app-tasks-abc */
function slugify(path: string): string {
  const s = path.replace(/^\/+|\/+$/g, '').replace(/[^a-zA-Z0-9]+/g, '-');
  return s || 'root';
}

/** Resolve a manifest path's dynamic `:segment`s from env, or mark it to skip. */
function resolveManifestPath(rawPath: string): { path: string; skipReason?: string } {
  if (!rawPath.includes(':')) return { path: rawPath };
  const id = DYNAMIC_PARAMS[rawPath];
  if (id) return { path: rawPath.replace(/:[^/]+/, id) };
  return {
    path: rawPath,
    skipReason: 'dynamic route — no ID provided (set QA_TASK_ID / QA_MISSION_ID or use QA_ROUTES)',
  };
}

let routes: Route[];
const adHoc = (process.env.QA_ROUTES ?? '').split(',').map((p) => p.trim()).filter(Boolean);

if (adHoc.length > 0) {
  routes = adHoc.map((path) => ({ id: slugify(path), path }));
  console.log(`[capture] ad-hoc mode — ${routes.length} route(s) from QA_ROUTES`);
} else {
  const manifest = JSON.parse(readFileSync(resolve(MANIFEST_PATH), 'utf-8'));
  routes = (manifest.routes as Array<{ id: string; path: string }>).map((r) => {
    const { path, skipReason } = resolveManifestPath(r.path);
    return { id: r.id, path, skipReason };
  });
  console.log(`[capture] manifest mode — ${routes.length} route(s) from ${MANIFEST_PATH}`);
}

// --- Browser + context ---
// A rejected top-level await lands in the swallow handlers above and the
// process exits 0 with nothing captured: a silent pass. No browser is fatal.
let browser: Awaited<ReturnType<typeof chromium.launch>>;
try {
  browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
} catch (err) {
  console.error(`[capture] browser did not launch: ${(err as Error).message.split('\n')[0]}`);
  process.exit(1);
}

if (BYPASS_SECRET) {
  // Bypass Vercel preview protection on every request (nav + page.request).
  contextOptions.extraHTTPHeaders = { 'x-vercel-protection-bypass': BYPASS_SECRET };
}
if (STORAGE_STATE_PATH && existsSync(STORAGE_STATE_PATH)) {
  contextOptions.storageState = STORAGE_STATE_PATH;
  console.log(storageStateFromSecret ? '[capture] using storage state from VISUAL_QA_STORAGE_STATE' : `[capture] using storage state from ${STORAGE_STATE_PATH}`);
}

const context = await browser.newContext(contextOptions);
// QA_THEME=light|dark seeds the theme the app's boot script reads, before any
// page script runs. Unset keeps the app default (dark).
const QA_THEME = process.env.QA_THEME?.trim();
if (QA_THEME) {
  await context.addInitScript((t) => localStorage.setItem('buildd-theme', t), QA_THEME);
  console.log(`[capture] theme ${QA_THEME}`);
}
const page = await context.newPage();
// Hydration mismatches and other client errors land in the run log, so a shot
// that looks fine but threw on load (React #418) is still visible.
page.on('pageerror', (err) => console.warn(`[capture] page error on ${page.url()}: ${err.message}`));
page.on('console', (msg) => {
  if (msg.type() === 'error') console.warn(`[capture] console error on ${page.url()}: ${msg.text().slice(0, 2000)}`);
});

// --- Auth ---
// If a storage state was loaded, we're already signed in. Otherwise fall back to
// the dev-auto-login credentials provider (NODE_ENV=development only).
// QA_NO_LOGIN skips the login POST entirely — used by shoot.sh, because a
// NODE_ENV=development server bypasses auth server-side (see auth-helpers.ts) and
// the POST just adds a slow, flaky CSRF round-trip.
// A preview is some other app: buildd's dev login and its /app/home check do
// not apply. Its auth walls are classified per route below instead.
let authenticated = Boolean(contextOptions.storageState);
if (!authenticated && !process.env.QA_NO_LOGIN && !IS_PREVIEW) {
  try {
    // Fetch CSRF token first
    const csrfResp = await page.request.get(`${BASE_URL}/api/auth/csrf`);
    const csrfData = await csrfResp.json().catch(() => ({ csrfToken: '' }));
    const csrfToken = csrfData?.csrfToken ?? '';

    if (csrfToken) {
      const signInResp = await page.request.post(`${BASE_URL}/api/auth/callback/credentials`, {
        form: {
          csrfToken,
          provider: 'dev-auto-login',
          callbackUrl: `${BASE_URL}/app/home`,
          redirect: 'false',
          email: '',
          password: '',
        },
      });
      if (signInResp.ok() || signInResp.status() === 302) {
        authenticated = true;
      }
    }
  } catch (err) {
    console.warn('[auth] warning during auth setup:', (err as Error).message);
  }
}

// Verify auth by navigating to home and checking we didn't land on a login page
if (!IS_PREVIEW) try {
  await page.goto(`${BASE_URL}/app/home`, { waitUntil: 'networkidle', timeout: 30_000 });
  const finalUrl = page.url();
  authenticated =
    !finalUrl.includes('/auth') && !finalUrl.includes('/login') && !finalUrl.includes('/signin');
} catch (err) {
  console.warn('[auth] warning verifying auth:', (err as Error).message);
}

console.log(`[capture] auth=${authenticated} base=${BASE_URL}`);

// --- Navigate and capture each route ---
type Capture = {
  id: string;
  path: string;
  url: string;
  finalUrl?: string;
  screenshotFile?: string;
  a11yFile?: string;
  redirected?: boolean;
  devOverlay?: boolean;
  /** sandbox | vercel-preview: copy into the shot's metadata.qa.source. */
  source: string;
  /** An auth wall, not a page: no screenshot was taken. */
  configError?: CaptureConfigError;
  configErrorMessage?: string;
  skipped?: boolean;
  skipReason?: string;
  error?: string;
  capturedAt: string;
};

const captures: Capture[] = [];

for (const route of routes) {
  if (route.skipReason) {
    captures.push({
      source: PAGE_SOURCE,
      id: route.id,
      path: route.path,
      url: `${BASE_URL}${route.path}`,
      skipped: true,
      skipReason: route.skipReason,
      capturedAt: new Date().toISOString(),
    });
    console.log(`[capture] SKIP  ${route.id} (${route.skipReason})`);
    continue;
  }

  const url = `${BASE_URL}${route.path}`;
  console.log(`[capture] GET   ${route.id} → ${url}`);

  try {
    const response = await page.goto(url, { waitUntil: 'networkidle', timeout: 30_000 });

    if (IS_PREVIEW) {
      const status = response?.status() ?? null;
      const wall = classifyPageLoad({
        requestedUrl: url,
        finalUrl: page.url(),
        status,
        bodyText: status === 401 || status === 403 ? (await page.content()).slice(0, 5000) : null,
        signInPaths: SIGN_IN_PATHS,
      });
      if (wall.kind === 'config_error') {
        captures.push({
          source: PAGE_SOURCE,
          id: route.id,
          path: route.path,
          url,
          finalUrl: new URL(page.url()).origin + new URL(page.url()).pathname,
          configError: wall.error,
          configErrorMessage: wall.message,
          capturedAt: new Date().toISOString(),
        });
        console.error(`[capture] WALL  ${route.id}: ${wall.error}`);
        // Every route sits behind deployment protection: stop at the first.
        if (wall.error === 'protection_bypass_missing') break;
        continue;
      }
    }

    // The Next.js dev error/build overlay renders in a <nextjs-portal> element and
    // obscures the real UI. Detect it (so the error signal is recorded, not lost),
    // then hide it unless QA_KEEP_DEV_OVERLAY asks to keep it for debugging.
    const devOverlay = (await page.locator('nextjs-portal').count()) > 0;
    if (devOverlay && !process.env.QA_KEEP_DEV_OVERLAY) {
      await page.addStyleTag({ content: 'nextjs-portal{display:none!important}' });
    }

    // The app scrolls inside <main class="overflow-y-auto">, not the window, so
    // fullPage alone stops at the viewport. Unclip every inner scroll container
    // (and its fixed-height ancestors) so the shot covers the whole page.
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

    const screenshotFile = `${route.id}.png`;
    const screenshotPath = join(OUTPUT_DIR, 'screenshots', screenshotFile);
    await page.screenshot({ path: screenshotPath, fullPage: true });

    // page.accessibility was removed in Playwright 1.52. Use ariaSnapshot() (1.44+)
    // which returns a YAML ARIA tree. Fall back to null if unavailable.
    let a11yData: string | null = null;
    try {
      a11yData = (await (page as any).ariaSnapshot()) as string;
    } catch {
      // best-effort — a11y data is informational only
    }
    const a11yFile = `${route.id}.json`;
    writeFileSync(
      join(OUTPUT_DIR, 'a11y', a11yFile),
      JSON.stringify({ ariaSnapshot: a11yData }, null, 2),
    );

    const finalUrl = page.url();
    captures.push({
      source: PAGE_SOURCE,
      id: route.id,
      path: route.path,
      url,
      finalUrl,
      screenshotFile,
      a11yFile,
      redirected: finalUrl !== url && !finalUrl.startsWith(url),
      devOverlay,
      capturedAt: new Date().toISOString(),
    });
    console.log(`[capture] OK    ${route.id} → ${finalUrl}${devOverlay ? ' [dev-overlay hidden]' : ''}`);
  } catch (err) {
    console.error(`[capture] FAIL  ${route.id}: ${(err as Error).message}`);
    captures.push({
      source: PAGE_SOURCE,
      id: route.id,
      path: route.path,
      url,
      error: (err as Error).message,
      capturedAt: new Date().toISOString(),
    });
  }
}

writeFileSync(join(OUTPUT_DIR, 'captures.json'), JSON.stringify(captures, null, 2));
await browser.close();
console.log(`[capture] done — ${captures.length} routes → ${OUTPUT_DIR}`);

// An auth wall is a configuration problem, never a visual finding, and never a
// pass: fail loudly with the fix, like a boot failure.
const walls = [...new Set(captures.map((c) => c.configError).filter((e): e is CaptureConfigError => !!e))];
if (walls.length > 0) {
  for (const w of walls) console.error(`[capture] CONFIG ERROR ${w}: ${CONFIG_ERROR_MESSAGES[w]}`);
  process.exit(3);
}
