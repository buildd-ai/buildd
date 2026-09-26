/**
 * check-live-refresh.ts — does an open dashboard page update on a live event,
 * without a reload?
 *
 *   bun run scripts/demo/check-live-refresh.ts [path] [from] [to]
 *   bun run demo:check-live                     # /app/home, t=30s → t=150s
 *
 * Needs the demo stack up and served (demo:up, demo:seed, demo:serve). Opens
 * `path` at story time `from`, reads a marker element, replays the story to `to`
 * (advance.ts writes the DB and pushes through soketi, exactly what a real
 * runner's updates look like to the page), then waits for the marker to change.
 * A reload afterwards shows what the page SHOULD have become; if the live page
 * never got there, the check fails.
 *
 * Why this exists: /app/home once stopped updating on live events. The
 * router.refresh() RSC request completed, but the React bundled with Next 16.2
 * dropped a Suspense ping that landed mid-render (see
 * apps/web/src/lib/next-bundled-react.test.ts), so the transition never
 * committed. The unit test pins that React property; this pins the behaviour.
 */
import { DEMO } from './lib/guard';
import { chromium } from 'playwright';
import { createLocalDb } from '../../packages/core/db/local-client';
import { loadState, loadStory } from './lib/story';
import { advanceTo } from './advance';
import { mintSessionToken, SESSION_COOKIE } from './lib/session';

const path = process.argv[2] ?? '/app/home';
const from = Number(process.argv[3] ?? 30);
const to = Number(process.argv[4] ?? 150);
const marker = process.env.DEMO_MARKER ?? '[data-testid="home-headline"]';
const waitMs = Number(process.env.DEMO_WAIT_MS ?? 20_000);

const db = createLocalDb();
await advanceTo(db, from, { quiet: true });
const state = await loadState(db);
const { story } = loadStory(state.storyPath);
const user = story.users[0];
const token = await mintSessionToken({ id: state.ids[user.key], email: user.email, name: user.name });

const browser = await chromium.launch({ headless: true });
let failed = false;
try {
  const base = new URL(DEMO.baseUrl);
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, timezoneId: story.team?.timezone ?? 'UTC' });
  await ctx.addCookies([
    { name: SESSION_COOKIE, value: token, domain: base.hostname, path: '/', httpOnly: true, sameSite: 'Lax' },
    { name: 'buildd-team', value: state.ids[story.team.key], domain: base.hostname, path: '/', sameSite: 'Lax' },
  ]);
  const page = await ctx.newPage();
  const read = () => page.locator(marker).first().innerText({ timeout: 10_000 });

  await page.goto(DEMO.baseUrl + path, { waitUntil: 'networkidle' });
  const before = await read();

  await advanceTo(db, to, { quiet: true });
  let live = before;
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline && live === before) {
    await page.waitForTimeout(500);
    live = await read();
  }

  await page.reload({ waitUntil: 'networkidle' });
  const reloaded = await read();

  console.log(`[check-live] ${path} ${marker}`);
  console.log(`  before  (t=${from}s): ${before}`);
  console.log(`  live    (t=${to}s):   ${live}`);
  console.log(`  reload  (t=${to}s):   ${reloaded}`);
  if (reloaded === before) {
    console.error('[check-live] INCONCLUSIVE: the story change between those times does not move this marker; pick other times');
    failed = true;
  } else if (live !== reloaded) {
    console.error(`[check-live] FAIL: the page did not update within ${waitMs}ms of the live events (a reload did)`);
    failed = true;
  } else {
    console.log('[check-live] ok: updated live, no reload');
  }
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
