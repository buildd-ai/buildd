/**
 * Visual QA capture — Playwright headless pass.
 *
 * Starts a headless Chromium session, signs in via the dev-auto-login credentials
 * provider (only available in NODE_ENV=development), then navigates to every route
 * in the manifest and saves a screenshot + a11y snapshot for each.
 *
 * Env vars:
 *   QA_BASE_URL   — base URL of the running app (default: http://localhost:3000)
 *   QA_OUTPUT     — directory for screenshots/a11y output (default: /tmp/qa)
 *   QA_MANIFEST   — path to visual-qa-routes.json (default: apps/web/src/qa/visual-qa-routes.json)
 */

import { chromium } from 'playwright';
import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'fs';
import { join, resolve } from 'path';

const BASE_URL = process.env.QA_BASE_URL ?? 'http://localhost:3000';
const OUTPUT_DIR = process.env.QA_OUTPUT ?? '/tmp/qa';
const MANIFEST_PATH = process.env.QA_MANIFEST ?? 'apps/web/src/qa/visual-qa-routes.json';

const manifest = JSON.parse(readFileSync(resolve(MANIFEST_PATH), 'utf-8'));

mkdirSync(join(OUTPUT_DIR, 'screenshots'), { recursive: true });
mkdirSync(join(OUTPUT_DIR, 'a11y'), { recursive: true });

const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
});

const context = await browser.newContext({
  viewport: { width: 1280, height: 900 },
});
const page = await context.newPage();

// --- Auth via dev-auto-login credentials provider ---
// This provider only exists when NODE_ENV=development (see apps/web/src/auth.ts).
// It has no credential fields, so we just POST to the callback endpoint.
// Use native fetch (not page.request) to avoid Playwright cookie-parsing errors
// that cause unhandled rejections and exit code 1.
let authenticated = false;
try {
  // Fetch CSRF token via native fetch (avoids Playwright set-cookie parsing bug)
  const csrfResp = await fetch(`${BASE_URL}/api/auth/csrf`);
  const csrfData = await csrfResp.json().catch(() => ({ csrfToken: '' }));
  const csrfToken = csrfData?.csrfToken ?? '';

  if (csrfToken) {
    // Extract any session cookies from the CSRF response
    const setCookieHeader = csrfResp.headers.get('set-cookie') ?? '';
    const cookieHeader = setCookieHeader
      .split(',')
      .map(c => c.split(';')[0].trim())
      .filter(Boolean)
      .join('; ');

    const signInResp = await fetch(`${BASE_URL}/api/auth/callback/credentials`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        ...(cookieHeader ? { Cookie: cookieHeader } : {}),
      },
      body: new URLSearchParams({
        csrfToken,
        provider: 'dev-auto-login',
        callbackUrl: `${BASE_URL}/app/home`,
        redirect: 'false',
        email: '',
        password: '',
      }).toString(),
      redirect: 'manual',
    });

    if (signInResp.ok || signInResp.status === 302) {
      // Inject the session cookie into the Playwright browser context
      const responseCookies = signInResp.headers.get('set-cookie') ?? '';
      const allCookies = [setCookieHeader, responseCookies]
        .join(',')
        .split(',')
        .map(c => c.trim())
        .filter(Boolean);

      for (const rawCookie of allCookies) {
        const [nameValue, ...attrs] = rawCookie.split(';').map(s => s.trim());
        const eqIdx = nameValue.indexOf('=');
        if (eqIdx < 0) continue;
        const name = nameValue.slice(0, eqIdx);
        const value = nameValue.slice(eqIdx + 1);
        const path = attrs.find(a => a.toLowerCase().startsWith('path='))?.split('=')[1] ?? '/';
        const httpOnly = attrs.some(a => a.toLowerCase() === 'httponly');
        try {
          await context.addCookies([{
            name, value, path,
            domain: 'localhost',
            httpOnly,
            secure: false,
            sameSite: 'Lax',
          }]);
        } catch {
          // best-effort — continue if one cookie fails
        }
      }
      authenticated = true;
    }
  }

  // Verify auth by navigating to home and checking we didn't land on a login page
  await page.goto(`${BASE_URL}/app/home`, { waitUntil: 'networkidle', timeout: 30_000 });
  const finalUrl = page.url();
  if (!finalUrl.includes('/auth') && !finalUrl.includes('/login') && !finalUrl.includes('/signin')) {
    authenticated = true;
  }
} catch (err) {
  console.warn('[auth] warning during auth setup:', (err as Error).message);
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
  skipped?: boolean;
  skipReason?: string;
  error?: string;
  capturedAt: string;
};

const captures: Capture[] = [];

for (const route of manifest.routes) {
  const rawPath: string = route.path;

  // Dynamic routes (contain :id) need a real fixture — skip in CI
  if (rawPath.includes(':')) {
    captures.push({
      id: route.id,
      path: rawPath,
      url: `${BASE_URL}${rawPath}`,
      skipped: true,
      skipReason: 'dynamic route — no CI fixture (needs real ID)',
      capturedAt: new Date().toISOString(),
    });
    console.log(`[capture] SKIP  ${route.id} (dynamic route)`);
    continue;
  }

  const url = `${BASE_URL}${rawPath}`;
  console.log(`[capture] GET   ${route.id} → ${url}`);

  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30_000 });

    const screenshotFile = `${route.id}.png`;
    const screenshotPath = join(OUTPUT_DIR, 'screenshots', screenshotFile);
    await page.screenshot({ path: screenshotPath, fullPage: true });

    // page.accessibility was removed in Playwright 1.44+; use ariaSnapshot() instead.
    let a11yContent = '';
    try {
      a11yContent = await (page as any).ariaSnapshot({ selector: 'body' }).catch(
        () => (page as any).ariaSnapshot(),
      );
    } catch {
      // a11y capture is best-effort — a missing snapshot degrades judgment quality but
      // does not block the screenshot or the overall capture.
    }
    const a11yFile = `${route.id}.txt`;
    writeFileSync(join(OUTPUT_DIR, 'a11y', a11yFile), a11yContent);

    const finalUrl = page.url();
    captures.push({
      id: route.id,
      path: rawPath,
      url,
      finalUrl,
      screenshotFile,
      a11yFile,
      redirected: finalUrl !== url && !finalUrl.startsWith(url),
      capturedAt: new Date().toISOString(),
    });
    console.log(`[capture] OK    ${route.id} → ${finalUrl}`);
  } catch (err) {
    console.error(`[capture] FAIL  ${route.id}: ${(err as Error).message}`);
    captures.push({
      id: route.id,
      path: rawPath,
      url,
      error: (err as Error).message,
      capturedAt: new Date().toISOString(),
    });
  }
}

writeFileSync(join(OUTPUT_DIR, 'captures.json'), JSON.stringify(captures, null, 2));
await browser.close();
console.log(`[capture] done — ${captures.length} routes → ${OUTPUT_DIR}`);
