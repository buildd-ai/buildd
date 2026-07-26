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
 *   VERCEL_AUTOMATION_BYPASS_SECRET — sets the x-vercel-protection-bypass header on every request
 *   QA_NO_LOGIN                     — skip the dev-auto-login POST (dev server bypasses auth already)
 *   QA_KEEP_DEV_OVERLAY             — keep the Next.js dev error overlay in shots (default: hide it)
 */

import { chromium } from 'playwright';
import type { BrowserContextOptions } from 'playwright';
import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'fs';
import { join, resolve } from 'path';

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

const STORAGE_STATE_PATH = process.env.VISUAL_QA_STORAGE_STATE_PATH ?? '';
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
const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
});

const contextOptions: BrowserContextOptions = {
  viewport: { width: 1280, height: 900 },
};
if (BYPASS_SECRET) {
  // Bypass Vercel preview protection on every request (nav + page.request).
  contextOptions.extraHTTPHeaders = { 'x-vercel-protection-bypass': BYPASS_SECRET };
}
if (STORAGE_STATE_PATH && existsSync(STORAGE_STATE_PATH)) {
  contextOptions.storageState = STORAGE_STATE_PATH;
  console.log(`[capture] using storage state from ${STORAGE_STATE_PATH}`);
}

const context = await browser.newContext(contextOptions);
const page = await context.newPage();

// --- Auth ---
// If a storage state was loaded, we're already signed in. Otherwise fall back to
// the dev-auto-login credentials provider (NODE_ENV=development only).
// QA_NO_LOGIN skips the login POST entirely — used by shoot.sh, because a
// NODE_ENV=development server bypasses auth server-side (see auth-helpers.ts) and
// the POST just adds a slow, flaky CSRF round-trip.
let authenticated = Boolean(contextOptions.storageState);
if (!authenticated && !process.env.QA_NO_LOGIN) {
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
try {
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
  skipped?: boolean;
  skipReason?: string;
  error?: string;
  capturedAt: string;
};

const captures: Capture[] = [];

for (const route of routes) {
  if (route.skipReason) {
    captures.push({
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
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30_000 });

    // The Next.js dev error/build overlay renders in a <nextjs-portal> element and
    // obscures the real UI. Detect it (so the error signal is recorded, not lost),
    // then hide it unless QA_KEEP_DEV_OVERLAY asks to keep it for debugging.
    const devOverlay = (await page.locator('nextjs-portal').count()) > 0;
    if (devOverlay && !process.env.QA_KEEP_DEV_OVERLAY) {
      await page.addStyleTag({ content: 'nextjs-portal{display:none!important}' });
    }

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
