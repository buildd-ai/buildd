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
 *   2. QA_PLAN set    → capture each plan route at its base state, then once per
 *                       named state after running that state's steps (open a
 *                       dialog, a menu, a gated sub-state). docs/specs/qa-capture-steps.md.
 *   3. otherwise      → capture every route in the manifest. Dynamic routes
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
 *   QA_PLAN                         — a capture plan: a path to a JSON file, or the JSON itself when it
 *                                     starts with `[`. `[{ route, states?: [{ key, steps }] }]`, steps
 *                                     from a closed list (click, hover, fill, press, select, waitFor,
 *                                     waitMs, assertLayout). Steps never commit: a write needs `commit: true`, which
 *                                     only QA_PAGE_SOURCE=sandbox honours, and every other write is
 *                                     aborted in the browser. Not combinable with QA_ROUTES. A failed
 *                                     assertLayout (overflow, a tap target under 44px below md) exits 4
 *                                     after every shot is written.
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
 *   QA_TEAM_ID                      — render as this team (sets the `buildd-team` cookie)
 *   QA_VIEWPORT                     — "mobile" (390x844 touch phone), "desktop", or WIDTHxHEIGHT (default: 1280x900)
 */

import { connectReviewBrowser, exposeService } from './browser-provider';
import type { BrowserContextOptions } from 'playwright';
import { readFileSync, mkdirSync, writeFileSync, existsSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { resolveViewport } from './viewport';
import { describeStep, guardWrites, parsePlan, planText, runSteps, type BlockedWrite, type PlanRoute, type Step, type StepFailure } from './steps';
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

// The capture plan, validated whole before the first await for the same
// reason: a bad plan, or a committing step against a preview, must exit 1
// before any page loads, never land in the swallow handlers below.
const adHoc = (process.env.QA_ROUTES ?? '').split(',').map((p) => p.trim()).filter(Boolean);
let plan: PlanRoute[] | null = null;
if (process.env.QA_PLAN?.trim()) {
  if (adHoc.length > 0) {
    console.error('[capture] set QA_ROUTES or QA_PLAN, not both');
    process.exit(1);
  }
  try {
    plan = parsePlan(planText(process.env.QA_PLAN, (p) => readFileSync(resolve(p), 'utf-8')), { pageSource: PAGE_SOURCE });
  } catch (err) {
    console.error(`[capture] ${(err as Error).message}`);
    process.exit(1);
  }
}

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
/** `state` + `steps`: a QA_PLAN state, shot after its steps on a fresh load. */
type Route = { id: string; path: string; skipReason?: string; state?: string; steps?: Step[] };

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

if (plan) {
  // Base first, then each state: required coverage is the base shot, and a
  // state's steps start from a fresh load so they never stack.
  // A pattern route (`/app/tasks/:id`) resolves like the manifest's, from
  // QA_TASK_ID / QA_MISSION_ID, so a committed plan carries no real id.
  routes = plan.flatMap((r) => {
    const { path, skipReason } = resolveManifestPath(r.route);
    const id = slugify(r.route.includes(':') ? path : r.route);
    return [
      { id, path, skipReason },
      ...r.states.map((s) => ({ id: `${id}--${s.key}`, path, skipReason, state: s.key, steps: s.steps })),
    ];
  });
  console.log(`[capture] plan mode — ${plan.length} route(s), ${routes.length - plan.length} state(s) from QA_PLAN`);
} else if (adHoc.length > 0) {
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
let browser: Awaited<ReturnType<typeof connectReviewBrowser>>['browser'];
let browserMetadata: { provider: string; handle?: string; probe: Record<string, unknown> };
try {
  if (process.env.BUILDD_BROWSER_PROVIDER === 'cloudflare') {
    const local = new URL(BASE_URL);
    if (['127.0.0.1', 'localhost'].includes(local.hostname)) await exposeService({ port: Number(local.port || 80) });
  }
  const connected = await connectReviewBrowser();
  browser = connected.browser;
  browserMetadata = { provider: connected.provider, handle: connected.handle, probe: connected.probe };
} catch (err) {
  const providerError = process.env.BUILDD_BROWSER_PROVIDER === 'cloudflare'
    ? ((err as Error).message.includes('service_') ? (err as Error).message : 'provider_handshake_failed')
    : 'provider_missing';
  writeFileSync(join(OUTPUT_DIR, 'captures.json'), JSON.stringify(routes.map(route => ({ id: route.id, path: route.path, providerError, error: providerError, capturedAt: new Date().toISOString(), browser: { provider: process.env.BUILDD_BROWSER_PROVIDER ?? 'local', probe: { ok: false } } })), null, 2));
  console.error(`[capture] browser did not launch: ${providerError}`);
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
// QA_TEAM_ID renders as that team: the same `buildd-team` cookie the team switcher
// sets (lib/active-team-client.ts). Unset keeps the user's default team.
const QA_TEAM_ID = process.env.QA_TEAM_ID?.trim();
if (QA_TEAM_ID) {
  await context.addCookies([{ name: 'buildd-team', value: encodeURIComponent(QA_TEAM_ID), url: BASE_URL }]);
  console.log('[capture] team set from QA_TEAM_ID');
}
const page = await context.newPage();
// Hydration mismatches and other client errors land in the run log, so a shot
// that looks fine but threw on load (React #418) is still visible.
// Counted per route as well (reset before each navigation) and recorded on the
// capture, so a consumer can tell "rendered" from "rendered but threw".
let pageErrors = 0;
page.on('pageerror', (err) => {
  pageErrors++;
  console.warn(`[capture] page error on ${page.url()}: ${err.message}`);
});
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
  /** HTTP status of the navigation's main response; null when none arrived. */
  status?: number | null;
  /** Uncaught page errors between navigation and the shot. */
  pageErrors?: number;
  screenshotFile?: string;
  a11yFile?: string;
  redirected?: boolean;
  devOverlay?: boolean;
  /** sandbox | vercel-preview: copy into the shot's metadata.qa.source. */
  source: string;
  /** A QA_PLAN state key: copy into the shot's metadata.qa.state. Absent on the base shot. */
  state?: string;
  /** The step that did not settle. The shot was still taken, at that point. */
  stepFailed?: StepFailure;
  /** Writes the page tried during the steps, aborted by the guard. */
  blockedWrites?: BlockedWrite[];
  /** An auth wall, not a page: no screenshot was taken. */
  configError?: CaptureConfigError;
  configErrorMessage?: string;
  skipped?: boolean;
  skipReason?: string;
  error?: string;
  providerError?: string;
  capturedAt: string;
};

const captures: Capture[] = [];

for (const route of routes) {
  // Present only on a state shot, so a QA_ROUTES run's entries are unchanged.
  const stateField = route.state ? { state: route.state } : {};
  if (route.skipReason) {
    captures.push({
      source: PAGE_SOURCE,
      ...stateField,
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

  let guard: Awaited<ReturnType<typeof guardWrites>> | null = null;
  try {
    pageErrors = 0;
    const response = await page.goto(url, { waitUntil: 'networkidle', timeout: 30_000 });
    const navStatus = response?.status() ?? null;

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
          ...stateField,
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

    // A plan state: run its steps with writes aborted, except a commit step,
    // which validatePlan only lets through on the sandbox. The guard stays up
    // until the shot is taken, so a write fired late by a step still stops.
    let stepFailed: StepFailure | null = null;
    if (route.steps) {
      guard = await guardWrites(page);
      const g = guard;
      stepFailed = await runSteps(page, route.steps, {
        beforeStep: (step) => g.allow(step.commit === true && PAGE_SOURCE === 'sandbox'),
        afterStep: () => g.allow(false),
      });
      if (stepFailed?.assertion) {
        console.error(`[capture] LAYOUT ${route.id}: ${stepFailed.error}`);
      } else if (stepFailed) {
        console.warn(`[capture] STEP  ${route.id}: steps[${stepFailed.index}] (${describeStep(route.steps[stepFailed.index])}) failed: ${stepFailed.error}; shooting the page as it stands`);
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
    // A state shot is the viewport instead: that is where a dialog or menu
    // renders, and unclipping would move what the steps just opened.
    if (!route.state) await page.evaluate(() => {
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
    await page.screenshot({ path: screenshotPath, fullPage: !route.state });

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
      ...stateField,
      id: route.id,
      path: route.path,
      url,
      finalUrl,
      status: navStatus,
      pageErrors,
      screenshotFile,
      a11yFile,
      redirected: finalUrl !== url && !finalUrl.startsWith(url),
      devOverlay,
      ...(stepFailed ? { stepFailed } : {}),
      ...(guard?.blocked.length ? { blockedWrites: [...guard.blocked] } : {}),
      capturedAt: new Date().toISOString(),
    });
    console.log(`[capture] OK    ${route.id} → ${finalUrl}${devOverlay ? ' [dev-overlay hidden]' : ''}`);
  } catch (err) {
    console.error(`[capture] FAIL  ${route.id}: ${(err as Error).message}`);
    captures.push({
      source: PAGE_SOURCE,
      ...stateField,
      id: route.id,
      path: route.path,
      url,
      error: (err as Error).message,
      ...(browserMetadata.provider === 'cloudflare' ? { providerError: /BlockedByClient|ERR_BLOCKED_BY_CLIENT/.test((err as Error).message) ? 'destination_blocked' : 'session_lost' } : {}),
      capturedAt: new Date().toISOString(),
    });
  } finally {
    await guard?.dispose();
  }
}

writeFileSync(join(OUTPUT_DIR, 'captures.json'), JSON.stringify(captures.map(c => ({ ...c, browser: browserMetadata })), null, 2));
await browser.close();
console.log(`[capture] done — ${captures.length} routes → ${OUTPUT_DIR}`);

// An auth wall is a configuration problem, never a visual finding, and never a
// pass: fail loudly with the fix, like a boot failure.
const walls = [...new Set(captures.map((c) => c.configError).filter((e): e is CaptureConfigError => !!e))];
if (walls.length > 0) {
  for (const w of walls) console.error(`[capture] CONFIG ERROR ${w}: ${CONFIG_ERROR_MESSAGES[w]}`);
  process.exit(3);
}

// A layout gate also fails when a prerequisite or measurement failed: it
// never passes without checking the requested scenario. Screenshots and
// metadata are written before the nonzero exit.
const layoutFailures = captures.filter((c) => c.stepFailed?.assertion);
if (layoutFailures.length > 0) {
  for (const c of layoutFailures) console.error(`[capture] LAYOUT FAILED ${c.id}: ${c.stepFailed!.error}`);
  process.exit(4);
}

if (captures.some(c => c.providerError)) process.exit(1);
