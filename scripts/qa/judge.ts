/**
 * Visual QA judge — sends captured pages to /api/qa/judge for Claude-powered
 * spec-drift evaluation. Auth uses BUILDD_API_KEY; no model key required in CI.
 *
 * CI path: capture.ts (Playwright in GH runner) → judge.ts → POST /api/qa/judge
 *
 * Env vars:
 *   BUILDD_API_KEY  — required; used as Bearer token for /api/qa/judge
 *   BUILDD_API_URL  — base URL (default: https://buildd.dev)
 *   QA_OUTPUT       — directory containing captures.json / screenshots / a11y
 *   QA_MANIFEST     — path to visual-qa-routes.json
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, resolve } from 'path';

const BUILDD_API_KEY = process.env.BUILDD_API_KEY;
if (!BUILDD_API_KEY) {
  console.error('[judge] BUILDD_API_KEY is required');
  process.exit(1);
}

const BUILDD_API_URL = (process.env.BUILDD_API_URL ?? 'https://buildd.dev').replace(/\/$/, '');
const OUTPUT_DIR = process.env.QA_OUTPUT ?? '/tmp/qa';
const MANIFEST_PATH = process.env.QA_MANIFEST ?? 'apps/web/src/qa/visual-qa-routes.json';

const manifest = JSON.parse(readFileSync(resolve(MANIFEST_PATH), 'utf-8'));
const rawCaptures: any[] = JSON.parse(readFileSync(join(OUTPUT_DIR, 'captures.json'), 'utf-8'));

// Enrich captures with inline binary data before sending to the server-side route.
// The route runs on Vercel and cannot read the runner's local filesystem.
const captures = rawCaptures.map((capture: any) => {
  if (capture.skipped || capture.error) return capture;

  const enriched = { ...capture };

  const screenshotPath = join(OUTPUT_DIR, 'screenshots', capture.screenshotFile ?? '');
  if (capture.screenshotFile && existsSync(screenshotPath)) {
    enriched.screenshotB64 = readFileSync(screenshotPath).toString('base64');
  }

  const a11yPath = join(OUTPUT_DIR, 'a11y', capture.a11yFile ?? '');
  if (capture.a11yFile && existsSync(a11yPath)) {
    enriched.a11yText = readFileSync(a11yPath, 'utf-8').substring(0, 4000);
  }

  return enriched;
});

console.log(`[judge] POSTing ${captures.length} captures to ${BUILDD_API_URL}/api/qa/judge`);

const resp = await fetch(`${BUILDD_API_URL}/api/qa/judge`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${BUILDD_API_KEY}`,
  },
  body: JSON.stringify({ captures, manifest }),
});

if (!resp.ok) {
  const errBody = await resp.text();
  console.error(`[judge] API error ${resp.status}: ${errBody.substring(0, 200)}`);
  process.exit(1);
}

const { verdicts, report } = await resp.json() as { verdicts: any[]; report: string };

writeFileSync(join(OUTPUT_DIR, 'verdicts.json'), JSON.stringify(verdicts, null, 2));
writeFileSync(join(OUTPUT_DIR, 'report.md'), report);

const pass = verdicts.filter((v: any) => v.overallVerdict === 'PASS').length;
const fail = verdicts.filter((v: any) => v.overallVerdict === 'FAIL').length;
const partial = verdicts.filter((v: any) => v.overallVerdict === 'PARTIAL').length;
const skipped = verdicts.filter((v: any) => v.overallVerdict === 'SKIPPED').length;

const overallStatus =
  fail > 0 || verdicts.some((v: any) => v.overallVerdict === 'ERROR')
    ? 'FAIL'
    : partial > 0
    ? 'PARTIAL'
    : 'PASS';

console.log(`[judge] done — ${verdicts.length} verdicts → ${OUTPUT_DIR}`);
console.log(`[judge] overall: ${overallStatus} (pass=${pass} fail=${fail} partial=${partial} skip=${skipped})`);
